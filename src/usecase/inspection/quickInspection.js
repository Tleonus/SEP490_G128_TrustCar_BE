import { ActivityEventType, CarStatus, InspectionSource, InspectionStatus, Permissions } from '../../constants/appConstants.js';
import { INSPECTION_LIMITS } from '../../config/inspectionChecklist.js';
import { CPO_CRITERIA, evaluateCpo } from '../../domain/inspection/criteria.js';

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const CRITERIA_KEYS = CPO_CRITERIA.map(({ criteriaKey }) => criteriaKey);
const INSPECTABLE_STATUSES = new Set([
  CarStatus.DRAFT, CarStatus.INCOMING, CarStatus.REJECTED, CarStatus.UNDER_INSPECTION, CarStatus.APPROVED_CPO,
]);
const MAX_CERTIFICATE_ATTEMPTS = 3;

function quickError(code, message, errors) {
  return Object.assign(new Error(message), { code, ...(errors ? { errors } : {}) });
}

/**
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-021
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-022
 */
function validateRequest(carId, actor, payload, isQuickInspectionImageUrl) {
  if (typeof actor?.id !== 'string' || !OBJECT_ID.test(actor.id) ||
      !Array.isArray(actor.permissions) || !actor.permissions.includes(Permissions.INSPECTION_WRITE)) {
    throw quickError('FORBIDDEN', 'Quick inspection requires inspection write permission.');
  }
  const { criteria, odo, notes = '', evidenceImages = [] } = payload ?? {};
  const errors = [];
  if (typeof carId !== 'string' || !OBJECT_ID.test(carId)) {
    errors.push({ field: 'id', message: 'Expected an ObjectId.' });
  }
  for (const key of CRITERIA_KEYS) {
    if (!Object.hasOwn(criteria ?? {}, key) || typeof criteria[key] !== 'boolean') {
      errors.push({ field: `criteria.${key}`, message: 'Expected a boolean.' });
    }
  }
  if (!Number.isSafeInteger(odo) || odo < 0) {
    errors.push({ field: 'odo', message: 'Expected a non-negative integer.' });
  }
  if (typeof notes !== 'string' || notes.trim().length > INSPECTION_LIMITS.NOTE_MAX_LENGTH) {
    errors.push({ field: 'notes', message: 'Invalid inspection notes.' });
  }
  if (!Array.isArray(evidenceImages) || evidenceImages.length > 20) {
    errors.push({ field: 'evidenceImages', message: 'Expected up to 20 photos.' });
  } else if (typeof carId === 'string' && OBJECT_ID.test(carId)) {
    for (const [index, url] of evidenceImages.entries()) {
      if (typeof url !== 'string' || url.length > 500 || !isQuickInspectionImageUrl(url, carId)) {
        errors.push({ field: `evidenceImages.${index}`, message: 'Image must be uploaded to this car’s quick inspection folder.' });
      }
    }
  }
  if (errors.length) throw quickError('VALIDATION_ERROR', 'Invalid quick inspection data.', errors);
  return {
    criteria: Object.fromEntries(CRITERIA_KEYS.map((key) => [key, criteria[key]])),
    odo, notes: notes.trim(), evidenceImages: [...evidenceImages],
  };
}

/**
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-020
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-021
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-039
 */
async function claimInspectableCar(cars, records, carId) {
  const car = await cars.findById(carId);
  if (!car) throw quickError('CAR_NOT_FOUND', 'Car not found.');
  // Draft creation takes the same claim before checking or inserting an open record.
  const claimed = INSPECTABLE_STATUSES.has(car.status) ? await cars.claimForInspection(carId, car) : null;
  const openRecord = await records.findOpenByCarId(carId);
  if (openRecord) {
    const code = openRecord.status === InspectionStatus.DRAFT ? 'INSPECTION_DRAFT_EXISTS' : 'INSPECTION_PENDING_APPROVAL';
    throw quickError(code, 'The car already has an open inspection.', [
      { field: 'inspectionId', message: String(openRecord.id) },
    ]);
  }
  if (!claimed) throw quickError('INVALID_CAR_STATUS', 'Car cannot be inspected in its current status.');
  return claimed;
}

/** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-028 */
async function appendEvents(audit, car, updatedCar, record, actorId) {
  const metadata = {
    inspectionId: record.id, carId: car.id, result: record.result,
    cpoCertificateId: record.cpoCertificateId, source: InspectionSource.ADMIN_QUICK,
  };
  await audit.append({
    eventType: ActivityEventType.INSPECTION_SUBMITTED, performedBy: actorId,
    targetModel: 'InspectionRecord', targetId: record.id, summary: `Quick inspection: ${record.result}`,
    metadata: { ...metadata, toStatus: InspectionStatus.SUBMITTED },
  });
  await audit.append({
    eventType: ActivityEventType.CAR_STATUS_CHANGED, performedBy: actorId,
    targetModel: 'Car', targetId: car.id, targetCode: car.vehicleCode ?? null,
    changes: { before: { status: car.status }, after: { status: updatedCar.status } },
    summary: `Inspection ${record.result}`, metadata,
  });
}

/**
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-020
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-021
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-026
 */
async function finalizeQuickInspection({ cars, records, audit }, {
  carId, actorId, input, getCertificateId, buildHistoryVerifyHash, now,
}) {
  const car = await claimInspectableCar(cars, records, carId);
  if (input.odo < (car.mileage ?? 0)) {
    throw quickError('MILEAGE_DECREASE', 'Odometer reading cannot be lower than the recorded mileage.');
  }
  const passed = evaluateCpo(input.criteria);
  const cpoCertificateId = passed ? getCertificateId() : null;
  const updatedCar = await cars.updateIfCurrent(carId, car, {
    status: passed ? CarStatus.APPROVED_CPO : CarStatus.REJECTED,
    mileage: input.odo, cpoCertificateId,
    historyVerifyHash: passed ? buildHistoryVerifyHash(car.id, cpoCertificateId) : null,
  });
  if (!updatedCar) throw quickError('INVALID_CAR_STATUS', 'Car changed before inspection could complete.');

  const inspectionRecord = await records.insert({
    ...input, carId: car.id, status: InspectionStatus.SUBMITTED, source: InspectionSource.ADMIN_QUICK,
    inspectorId: actorId, createdBy: actorId, submittedBy: actorId, submittedAt: now(),
    result: passed ? 'PASSED' : 'FAILED', cpoCertificateId,
  });
  await appendEvents(audit, car, updatedCar, inspectionRecord, actorId);
  return { car: updatedCar, inspectionRecord };
}

/** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-020 */
export function createQuickInspection({
  unitOfWork, isQuickInspectionImageUrl, generateCpoCertificate, buildHistoryVerifyHash, isCertificateCollision,
  now = () => new Date(),
}) {
  return async function inspectCar(carId, actor, payload) {
    const input = validateRequest(carId, actor, payload, isQuickInspectionImageUrl);
    for (let attempt = 0; attempt < MAX_CERTIFICATE_ATTEMPTS; attempt += 1) {
      let candidate;
      try {
        return await unitOfWork.run((repositories) => finalizeQuickInspection(repositories, {
          carId, actorId: actor.id, input, buildHistoryVerifyHash, now,
          getCertificateId: () => (candidate ??= generateCpoCertificate()),
        }));
      } catch (error) {
        if (!candidate || !isCertificateCollision(error)) throw error;
      }
    }
    throw quickError('CPO_CODE_GENERATION_FAILED', 'Could not generate a unique CPO certificate code.');
  };
}
