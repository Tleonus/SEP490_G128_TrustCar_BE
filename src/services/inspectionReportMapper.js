/**
 * @file inspectionReportMapper.js
 * @description Builds the PUBLIC inspection report of a CPO-certified car from
 * its certifying inspection record. Pure (no database).
 *
 * Every output field is copied explicitly (allow-list): internal technical
 * notes, user ids, seller-declared mileage, Cloudinary public ids and contact
 * data are never part of the report, whatever the stored record contains.
 */

import {
  CHECKLIST_VERSION, OVERVIEW_POSITIONS, PUBLIC_REPORT_SCOPE_NOTE, getChecklist,
} from '../config/inspectionChecklist.js';
import { InspectionSource } from '../constants/appConstants.js';
import { isPublicImageUrl } from './inspectionMediaService.js';

/** FULL = digital checklist record; MINIMAL = quick (5-boolean) or pre-checklist record. */
export const ReportLevel = Object.freeze({ FULL: 'FULL', MINIMAL: 'MINIMAL' });

/**
 * Shortens a person's name to initials: "Nguyễn Văn An" → "N.V.A.".
 * @param {string} fullName
 * @returns {string|null} null when there is no usable name
 */
export const toInitials = (fullName) => {
  if (typeof fullName !== 'string') return null;
  const words = fullName.normalize('NFC').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return `${words.map((word) => word.charAt(0).toLocaleUpperCase('vi')).join('.')}.`;
};

const publicPhotos = (urls = []) => (urls || []).filter((url) => isPublicImageUrl(url));
const publicPhoto = (url) => (isPublicImageUrl(url) ? url : null);
const labelOf = (list, key) => list.find((entry) => entry.key === key)?.label || key;
const toIso = (value) => (value ? new Date(value).toISOString() : null);

const vehicleFrom = (source, mileage) => ({
  make: source?.make ?? null,
  model: source?.model ?? null,
  variant: source?.variant ?? null,
  color: source?.color ?? null,
  year: source?.year ?? null,
  mileage: mileage ?? null,
});

/** One group of a FULL report: checked items, evidence photos and public minor defects. */
const fullGroup = (def, group, passed) => {
  const items = def.items
    .map((itemDef) => (group?.items || []).find((item) => item.itemKey === itemDef.key))
    .filter(Boolean);
  return {
    key: def.key,
    label: def.label,
    passed,
    items: items.map((item) => ({ key: item.itemKey, label: labelOf(def.items, item.itemKey), result: item.result })),
    photos: publicPhotos([
      ...(group?.photos || []),
      ...items.flatMap((item) => item.photos || []),
      ...(group?.odometerPhoto ? [group.odometerPhoto] : []),
    ]),
    minorDefects: (group?.minorDefects || []).map((defect) => ({
      type: defect.type,
      label: labelOf(def.minorDefectTypes, defect.type),
      location: defect.location || '',
      description: defect.description || '',
      photos: publicPhotos(defect.photos),
    })),
  };
};

/**
 * @param {object} params
 * @param {object} params.car - lean Car (make, model, variant, specifications.color, year)
 * @param {object} params.record - lean certifying InspectionRecord
 * @param {string|null} [params.inspectorName] - full name of the inspector, if known
 * @returns {object} public report (SPEC KAN-15 §5)
 */
export const buildPublicReport = ({ car, record, inspectorName = null }) => {
  const checklist = getChecklist(record.checklistVersion) || getChecklist(CHECKLIST_VERSION);
  const level = record.source === InspectionSource.STAFF ? ReportLevel.FULL : ReportLevel.MINIMAL;
  // The 5 booleans are what the certificate was issued on, for every kind of record.
  const passedOf = (def) => record.criteria?.[def.criteriaKey] === true;

  const base = {
    certificateId: record.cpoCertificateId,
    issuedAt: toIso(record.submittedAt || record.createdAt),
    level,
    inspector: toInitials(inspectorName),
  };

  if (level === ReportLevel.FULL) {
    return {
      ...base,
      vehicle: vehicleFrom(record.vehicleInfo?.confirmed, record.vehicleInfo?.confirmed?.mileage),
      overviewPhotos: Object.fromEntries(OVERVIEW_POSITIONS.map((pos) => [pos, publicPhoto(record.overviewPhotos?.[pos])])),
      groups: checklist.map((def) => fullGroup(def, (record.groups || []).find((g) => g.groupKey === def.key), passedOf(def))),
      photos: [],
      scopeNote: PUBLIC_REPORT_SCOPE_NOTE,
    };
  }

  return {
    ...base,
    // Mileage is the reading taken at the inspection, never the seller's declared value.
    vehicle: vehicleFrom({ ...car, color: car?.specifications?.color }, record.odo),
    overviewPhotos: null,
    groups: checklist.map((def) => ({
      key: def.key, label: def.label, passed: passedOf(def), items: [], photos: [], minorDefects: [],
    })),
    photos: publicPhotos(record.evidenceImages),
    scopeNote: PUBLIC_REPORT_SCOPE_NOTE,
  };
};

export default { buildPublicReport, toInitials, ReportLevel };
