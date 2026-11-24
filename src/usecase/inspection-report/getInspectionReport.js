import { CarStatus, InspectionSource, InspectionStatus } from '../../constants/appConstants.js';
import { CPO_CRITERIA } from '../../domain/inspection/criteria.js';

const reportableStatuses = new Set([CarStatus.APPROVED_CPO, CarStatus.AVAILABLE]);
const objectIdPattern = /^[a-f0-9]{24}$/i;
const vehicleCodePattern = /^TC-\d{4}-\d{4}$/;

const isObjectId = (value) => typeof value === 'string' && value.length === 24 && objectIdPattern.test(value);
const reportNotFound = () => Object.assign(new Error('Inspection report not found.'), {
  code: 'INSPECTION_REPORT_NOT_FOUND', statusCode: 404,
});

/** @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-002 */
function carLookup(idOrCode) {
  if (isObjectId(idOrCode)) return { kind: 'id', value: idOrCode.toLowerCase() };
  if (typeof idOrCode === 'string' && idOrCode.length === 12 && vehicleCodePattern.test(idOrCode)) {
    return { kind: 'vehicleCode', value: idOrCode };
  }
  throw reportNotFound();
}

/** @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-008 */
function initials(fullName) {
  if (typeof fullName !== 'string' || !fullName.trim()) return null;
  return fullName.normalize('NFC').trim().split(/\s+/)
    .map((word) => `${String.fromCodePoint(word.codePointAt(0)).toLocaleUpperCase('vi')}.`).join('');
}

/** @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-007 */
function isoDate(value) {
  if (!(value instanceof Date) && (typeof value !== 'string' || !value.trim())) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

const textOrNull = (value) => typeof value === 'string' ? value : null;
const numberOrNull = (value) => Number.isFinite(value) ? value : null;

/** @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-004
 * @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-005
 */
function vehicleInfo(info, mileage) {
  return {
    make: textOrNull(info?.make),
    model: textOrNull(info?.model),
    variant: textOrNull(info?.variant),
    color: textOrNull(info?.color),
    year: numberOrNull(info?.year),
    mileage: numberOrNull(mileage),
  };
}

/** @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-006 */
function passedCriteria(criteria = {}) {
  return CPO_CRITERIA.filter(({ criteriaKey }) => Object.hasOwn(criteria ?? {}, criteriaKey) && criteria[criteriaKey] === true)
    .map(({ key, label }) => ({ key, label, passed: true }));
}

/**
 * @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-001
 * @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-003
 * @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-007
 * @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-008
 * @param {{ reader: import('./ports/inspectionReportPort.js').InspectionReportReader }} dependencies
 */
export function createGetInspectionReport({ reader }) {
  return async function getInspectionReport(idOrCode) {
    const lookup = carLookup(idOrCode);
    const car = await reader.findCar(lookup);
    if (car?.isActive !== true || !reportableStatuses.has(car.status) || !isObjectId(car.id) ||
        typeof car.cpoCertificateId !== 'string' || !car.cpoCertificateId.trim()) throw reportNotFound();

    const record = await reader.findCertifyingInspection(car.id, car.cpoCertificateId);
    if (!record || record.carId !== car.id || record.cpoCertificateId !== car.cpoCertificateId ||
        (record.status ?? InspectionStatus.SUBMITTED) !== InspectionStatus.SUBMITTED ||
        record.result !== 'PASSED') throw reportNotFound();

    const inspectorId = isObjectId(record.submittedBy) ? record.submittedBy : record.inspectorId;
    const inspector = isObjectId(inspectorId) ? initials(await reader.findInspectorName(inspectorId)) : null;
    const full = record.source === InspectionSource.STAFF;
    return {
      certificateId: record.cpoCertificateId,
      issuedAt: isoDate(record.submittedAt) ?? isoDate(record.createdAt),
      level: full ? 'FULL' : 'MINIMAL',
      inspector,
      vehicle: full ? vehicleInfo(record.confirmedVehicle, record.confirmedVehicle?.mileage) : vehicleInfo(car, record.odo),
      groups: passedCriteria(record.criteria),
    };
  };
}
