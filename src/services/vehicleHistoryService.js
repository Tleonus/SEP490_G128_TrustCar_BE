/**
 * @file vehicleHistoryService.js
 * @description KAN-98 Vehicle History Report service layer.
 *
 * - `buildHistoryVerifyHash(carId, certificateId)`: deterministic sha256-based
 *   24-char hash, re-derived every time a car is certified so old QR codes stop
 *   resolving once the vehicle is re-inspected.
 * - `getHistoryReport(idOrCode)`: loads the car, its certifying inspection
 *   record, every submitted inspection and maintenance ActivityLog entries, and
 *   calls the pure builder. Self-heals missing hash for data created before
 *   KAN-98.
 * - `getVerifySummary(hash)`: public 404-or-summary lookup used by the QR
 *   verify page.
 *
 * Every error path returns the same 404 code so unknown hashes, expired hashes
 * and malformed hashes cannot be distinguished by a caller.
 */

import crypto from 'crypto';
import Car from '../models/Car.js';
import InspectionRecord from '../models/InspectionRecord.js';
import ActivityLog from '../models/ActivityLog.js';
import User from '../models/User.js';
import { AppError } from '../utils/apiResponse.js';
import {
  ActivityEventType, CarStatus, InspectionStatus,
} from '../constants/appConstants.js';
import { buildPublicReport } from './inspectionReportMapper.js';
import { buildVehicleHistoryReport } from './vehicleHistoryReport.js';

export const HISTORY_HASH_LENGTH = 24;
const HASH_REGEX = /^[0-9a-f]{24}$/;

const secret = () =>
  process.env.VERIFY_HASH_SECRET
  || process.env.JWT_SECRET
  || 'trustcar-dev-verify';

const FRONTEND_URL = () =>
  (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');

/**
 * Deterministic 24-hex-char hash of (carId, certificateId, secret). Not
 * reversible; changes whenever a new certificate is issued so a previous QR
 * image becomes a 404.
 *
 * @param {string|object} carId
 * @param {string} certificateId
 * @returns {string}
 */
export const buildHistoryVerifyHash = (carId, certificateId) =>
  crypto.createHash('sha256')
    .update(`${String(carId)}:${certificateId}:${secret()}`)
    .digest('hex')
    .slice(0, HISTORY_HASH_LENGTH);

/** Absolute URL a QR code should point at for the given hash. */
export const buildVerifyUrl = (hash) =>
  `${FRONTEND_URL()}/verify/${encodeURIComponent(hash)}`;

const REPORTABLE_CAR_STATUSES = [
  CarStatus.APPROVED_CPO, CarStatus.AVAILABLE, CarStatus.RESERVED, CarStatus.SOLD,
];

const HISTORY_CAR_PROJECTION = {
  vehicleCode: 1, make: 1, model: 1, variant: 1, year: 1, fuelType: 1, transmission: 1,
  mileage: 1, 'specifications.color': 1,
  cpoCertificateId: 1, historyVerifyHash: 1, status: 1, isActive: 1,
  previousOwnersCount: 1, registrationDate: 1, ownerType: 1, serviceHistory: 1,
  priceHistory: 1, createdAt: 1, listedDate: 1,
};

const VERIFY_PROJECTION = {
  vehicleCode: 1, make: 1, model: 1, variant: 1, year: 1, 'specifications.color': 1,
  mileage: 1, status: 1, isActive: 1,
  cpoCertificateId: 1, historyVerifyHash: 1, previousOwnersCount: 1,
  priceHistory: 1,
};

const notFound = () =>
  new AppError('Vehicle history not found.', 404, 'VEHICLE_HISTORY_NOT_FOUND');

const verifyNotFound = () =>
  new AppError('Verification record not found.', 404, 'VERIFY_NOT_FOUND');

/**
 * Loads a car by ObjectId or vehicleCode. 404s if it is inactive, has no CPO
 * certificate, or is not in a reportable status.
 */
const loadCar = async (idOrCode) => {
  const key = String(idOrCode);
  const byId = /^[0-9a-fA-F]{24}$/.test(key);
  const car = await Car.findOne({
    ...(byId ? { _id: key } : { vehicleCode: key }),
    isActive: true,
    status: { $in: REPORTABLE_CAR_STATUSES },
    cpoCertificateId: { $ne: null },
  }, HISTORY_CAR_PROJECTION).lean();
  if (!car?.cpoCertificateId) throw notFound();
  return car;
};

/**
 * Self-heals the verify hash for cars certified before KAN-98 (and for seeded
 * data). Idempotent: only writes when the stored value is absent.
 */
const ensureVerifyHash = async (car) => {
  if (car.historyVerifyHash) return car.historyVerifyHash;
  const hash = buildHistoryVerifyHash(car._id, car.cpoCertificateId);
  await Car.updateOne(
    { _id: car._id, historyVerifyHash: null },
    { $set: { historyVerifyHash: hash } },
  );
  return hash;
};

/**
 * Loads the certifying inspection record and every SUBMITTED inspection of a car.
 * Returns `{ certRecord, inspectionRecords, inspectorNames }` already hydrated.
 */
const loadInspections = async (car) => {
  // Records without a status predate the digital checklist and were always final,
  // so the filter is applied in JS rather than with an `$exists` clause.
  const all = await InspectionRecord.find({ carId: car._id })
    .sort({ submittedAt: 1 }).lean();
  const records = all.filter((r) => (r.status || InspectionStatus.SUBMITTED) === InspectionStatus.SUBMITTED);

  const certRaw = records.find((r) => r.cpoCertificateId === car.cpoCertificateId) || null;

  const inspectorIds = Array.from(new Set(
    records.map((r) => r.submittedBy || r.inspectorId).filter(Boolean).map(String),
  ));
  const users = inspectorIds.length
    ? await User.find({ _id: { $in: inspectorIds } }).select('fullName').lean()
    : [];
  const inspectorNames = Object.fromEntries(users.map((u) => [String(u._id), u.fullName || null]));

  const certInspectorName = certRaw
    ? inspectorNames[String(certRaw.submittedBy || certRaw.inspectorId || '')]
    : null;

  const certRecord = certRaw
    ? buildPublicReport({ car, record: certRaw, inspectorName: certInspectorName })
    : null;

  return { certRecord, inspectionRecords: records, inspectorNames };
};

/**
 * Loads maintenance-related CAR_STATUS_CHANGED ActivityLog entries. The
 * caller filters down to `after.status === 'MAINTENANCE'` since the
 * ActivityLog does not index that path.
 */
const loadMaintenanceLogs = async (car) =>
  ActivityLog.find({
    targetModel: 'Car',
    targetId: car._id,
    eventType: ActivityEventType.CAR_STATUS_CHANGED,
  }).lean();

/**
 * Public entry point used by the PDF renderer and by tests. Returns the
 * assembled report object defined in services/vehicleHistoryReport.js §5.
 *
 * @param {string} idOrCode
 * @returns {Promise<object>}
 */
export const getHistoryReport = async (idOrCode) => {
  const car = await loadCar(idOrCode);
  const verifyHash = await ensureVerifyHash(car);
  car.historyVerifyHash = verifyHash;

  const { certRecord, inspectionRecords, inspectorNames } = await loadInspections(car);
  const maintenanceSessions = await loadMaintenanceLogs(car);

  return buildVehicleHistoryReport({
    car,
    certRecord,
    inspectionRecords,
    maintenanceSessions,
    inspectorNames,
    verifyHash,
    verifyUrl: buildVerifyUrl(verifyHash),
  });
};

/**
 * Lightweight summary consumed by the public `/verify/:hash` page. Hash format
 * is checked before touching the database so malformed hashes do not probe it.
 *
 * @param {string} hash
 * @returns {Promise<object>}
 */
export const getVerifySummary = async (hash) => {
  if (typeof hash !== 'string' || !HASH_REGEX.test(hash)) throw verifyNotFound();

  const car = await Car.findOne({
    historyVerifyHash: hash,
    isActive: true,
  }, VERIFY_PROJECTION).lean();
  if (!car) throw verifyNotFound();

  // Certifying record gives us issuedAt + PASSED result.
  const certRecord = await InspectionRecord.findOne({
    carId: car._id,
    cpoCertificateId: car.cpoCertificateId,
  }).lean();

  const title = [car.make, car.model, car.variant].filter(Boolean).join(' ') || null;
  const priceChangesCount = Math.max(0, (car.priceHistory || []).length - 1);

  return {
    verified: true,
    vehicle: {
      vehicleCode: car.vehicleCode || null,
      title,
      year: car.year || null,
      color: car?.specifications?.color || null,
      currentMileage: typeof car.mileage === 'number' ? car.mileage : null,
    },
    certificate: {
      id: car.cpoCertificateId,
      issuedAt: certRecord?.submittedAt
        ? new Date(certRecord.submittedAt).toISOString() : null,
      result: certRecord?.result || 'PASSED',
    },
    score: {
      previousOwnersCount: Number(car.previousOwnersCount || 0),
      inspectionsCount: certRecord ? 1 : 0,
      priceChangesCount,
      maintenanceCount: 0, // summary stays cheap; full count lives on the PDF
    },
    status: car.status || null,
    pdfUrl: `/api/v1/public/history/${encodeURIComponent(car.vehicleCode || car._id)}/pdf`,
    generatedAt: new Date().toISOString(),
  };
};

export default {
  buildHistoryVerifyHash,
  buildVerifyUrl,
  getHistoryReport,
  getVerifySummary,
  HISTORY_HASH_LENGTH,
};
