/**
 * @file vehicleHistoryReport.js
 * @description Pure builder for the KAN-98 Vehicle History Report. Takes
 * already-loaded Car + inspection records + maintenance ActivityLog entries
 * and shapes them into a public-safe report object. No DB access.
 *
 * Allow-lists every field — vin, licensePlate, floorPrice, originalPrice,
 * costPrice and internalNotes must NEVER appear in the output, whatever the
 * caller passes in.
 */

import { toInitials, ReportLevel } from './inspectionReportMapper.js';
import { PUBLIC_REPORT_SCOPE_NOTE } from '../config/inspectionChecklist.js';

const PRICE_HISTORY_LIMIT = 12;

const toIso = (value) => (value ? new Date(value).toISOString() : null);

const daysBetween = (fromIso, toIso2) => {
  if (!fromIso || !toIso2) return null;
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso2).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, Math.round((to - from) / 86400000));
};

/**
 * Builds the ODO history by merging intake mileage and inspection odometer readings.
 * Returns points sorted ascending by time, deduplicated by (day, value).
 */
const buildOdoHistory = ({ car, inspectionRecords }) => {
  const points = [];
  if (Number(car.mileage) > 0 && car.createdAt) {
    points.push({ at: toIso(car.createdAt), value: Number(car.mileage), source: 'INTAKE' });
  }
  (inspectionRecords || []).forEach((rec) => {
    const odo = Number(rec.odo);
    if (!Number.isFinite(odo) || odo <= 0) return;
    const at = toIso(rec.submittedAt || rec.createdAt);
    if (!at) return;
    points.push({ at, value: odo, source: 'INSPECTION' });
  });
  points.sort((a, b) => new Date(a.at) - new Date(b.at));
  // Deduplicate by (day, value)
  const seen = new Set();
  const unique = [];
  points.forEach((p) => {
    const day = p.at.slice(0, 10);
    const key = `${day}|${p.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(p);
  });
  return unique;
};

/**
 * Picks price-change rows from Car.priceHistory, newest first, capped at
 * PRICE_HISTORY_LIMIT. Each row is derived from two consecutive entries so no
 * raw `price` value is leaked — only the delta and the resulting new price.
 */
const buildPriceHistory = (priceHistory = []) => {
  const sorted = [...(priceHistory || [])]
    .filter((p) => p && typeof p.price === 'number')
    .sort((a, b) => new Date(a.changedAt || 0) - new Date(b.changedAt || 0));
  const rows = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    rows.push({
      at: toIso(curr.changedAt),
      oldPrice: prev.price,
      newPrice: curr.price,
      dropAmount: prev.price - curr.price,
      reason: curr.reason || null,
    });
  }
  rows.reverse(); // newest first
  if (rows.length <= PRICE_HISTORY_LIMIT) return { items: rows, truncated: false };
  return { items: rows.slice(0, PRICE_HISTORY_LIMIT), truncated: true };
};

/**
 * Merges workshop maintenance (from ActivityLog CAR_STATUS_CHANGED → MAINTENANCE)
 * with declared service history (from Car.serviceHistory). Newest first.
 */
const buildMaintenance = ({ maintenanceSessions = [], serviceHistory = [] }) => {
  const workshop = (maintenanceSessions || [])
    .filter((log) => log?.changes?.after?.status === 'MAINTENANCE')
    .map((log) => ({
      at: toIso(log.createdAt),
      kind: 'WORKSHOP',
      description: log.summary || 'Vao xuong bao duong truoc ban',
      provider: null,
      odometer: null,
    }));
  const declared = (serviceHistory || []).map((entry) => ({
    at: toIso(entry.performedAt),
    kind: 'DECLARED',
    description: entry.description || '',
    provider: entry.provider || null,
    odometer: typeof entry.odometer === 'number' ? entry.odometer : null,
  }));
  const merged = [...workshop, ...declared].filter((x) => x.at);
  merged.sort((a, b) => new Date(b.at) - new Date(a.at));
  return merged;
};

/**
 * Builds the public inspection summary list from every SUBMITTED inspection of the car.
 * Caller provides `inspectorNames` map keyed by inspector user id string.
 */
const buildInspections = ({ inspectionRecords = [], inspectorNames = {} }) =>
  (inspectionRecords || [])
    .map((rec) => {
      const inspectorId = rec.submittedBy || rec.inspectorId;
      const name = inspectorId ? inspectorNames[String(inspectorId)] : null;
      return {
        at: toIso(rec.submittedAt || rec.createdAt),
        result: rec.result || null,
        certificateId: rec.cpoCertificateId || null,
        inspectorInitials: toInitials(name) || null,
      };
    })
    .filter((r) => r.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at));

/**
 * @param {object} params
 * @param {object} params.car - lean Car (allow-listed projection)
 * @param {object|null} params.certRecord - public report of the certifying inspection
 * @param {object[]} [params.inspectionRecords] - every SUBMITTED InspectionRecord of the car
 * @param {object[]} [params.maintenanceSessions] - ActivityLog entries with eventType CAR_STATUS_CHANGED
 * @param {Record<string,string>} [params.inspectorNames] - inspector id → full name
 * @param {string} params.verifyHash
 * @param {string} params.verifyUrl
 * @param {string} [params.generatedAt]
 * @returns {object} VehicleHistoryReport (SPEC KAN-98 §5)
 */
export const buildVehicleHistoryReport = ({
  car,
  certRecord,
  inspectionRecords = [],
  maintenanceSessions = [],
  inspectorNames = {},
  verifyHash,
  verifyUrl,
  generatedAt = new Date().toISOString(),
}) => {
  const intakeAt = toIso(car.createdAt);
  const listedAt = toIso(car.listedDate || car.createdAt);
  const odometerHistory = buildOdoHistory({ car, inspectionRecords });
  const price = buildPriceHistory(car.priceHistory);
  const maintenance = buildMaintenance({ maintenanceSessions, serviceHistory: car.serviceHistory });
  const inspections = buildInspections({ inspectionRecords, inspectorNames });

  const certVehicle = certRecord?.vehicle || {};
  const certGroups = certRecord?.groups || [];

  return {
    verifyHash,
    verifyUrl,
    generatedAt,
    certificate: certRecord
      ? {
          id: certRecord.certificateId || car.cpoCertificateId || null,
          issuedAt: certRecord.issuedAt || null,
          inspectorInitials: certRecord.inspector || null,
          level: certRecord.level || ReportLevel.FULL,
        }
      : null,
    vehicle: {
      vehicleCode: car.vehicleCode || null,
      make: car.make ?? certVehicle.make ?? null,
      model: car.model ?? certVehicle.model ?? null,
      variant: car.variant ?? certVehicle.variant ?? null,
      color: car?.specifications?.color ?? certVehicle.color ?? null,
      year: car.year ?? certVehicle.year ?? null,
      currentMileage: typeof car.mileage === 'number' ? car.mileage : null,
      fuelType: car.fuelType || null,
      transmission: car.transmission || null,
    },
    ownership: {
      previousOwnersCount: Number(car.previousOwnersCount || 0),
      registrationDate: toIso(car.registrationDate),
      ownerType: car.ownerType || null,
      intakeAt,
      daysInStock: daysBetween(listedAt, generatedAt),
    },
    odometerHistory: {
      items: odometerHistory,
      insufficientData: odometerHistory.length < 2,
    },
    priceHistory: price,
    maintenance,
    inspections,
    criteria: certGroups.map((g) => ({
      key: g.key, label: g.label, passed: !!g.passed,
    })),
    minorDefects: certGroups
      .flatMap((g) => (g.minorDefects || []).map((d) => ({
        label: d.label || d.type || null,
        location: d.location || '',
        description: d.description || '',
      }))),
    scopeNote: certRecord?.scopeNote || PUBLIC_REPORT_SCOPE_NOTE,
  };
};

export default { buildVehicleHistoryReport };
