/**
 * @file inspectionSubmitService.js
 * @description Submitting a digital inspection checklist, and the quick
 * inspection (5 booleans, inspector or admin). Validation, verdict, car update, certificate code,
 * record and audit entries happen in ONE transaction: all stored or none.
 * Both paths decide the verdict with the same evaluateCPO().
 */

import Car from '../models/Car.js';
import InspectionRecord, { withLifecycleDefaults } from '../models/InspectionRecord.js';
import {
  ActivityEventType, CarStatus, InspectionSource, InspectionStatus, Roles,
} from '../constants/appConstants.js';
import { getChecklist } from '../config/inspectionChecklist.js';
import { AppError } from '../utils/apiResponse.js';
import { withTransaction } from '../utils/withTransaction.js';
import { isImageInFolder, isInspectionImageUrl, quickInspectionFolder } from './inspectionMediaService.js';
import { collectSubmitViolations, listRecordImages } from './inspectionSubmitRules.js';
import { computeGroupResults, deriveCriteria, evaluateCPO } from './inspectionVerdict.js';
import {
  INSPECTABLE_CAR_STATUSES, applyVerdictToCar, carStatusEvent, draftExistsError, lockedError, logEvents, notFound,
} from './inspectionShared.js';

/** Joins non-empty group notes into the KAN-14 `notes` summary. */
const summariseNotes = (groups, checklist) => groups
  .filter((group) => group.note && group.note.trim())
  .map((group) => `${checklist.find((def) => def.key === group.groupKey)?.label || group.groupKey}: ${group.note.trim()}`)
  .join('\n');

/**
 * Validates and submits a draft. On success the record is locked, the car is
 * APPROVED_CPO (with a certificate) or REJECTED, and its mileage never decreases.
 *
 * @param {string} id - inspection record id
 * @param {string} userId - staff member submitting
 * @returns {Promise<{ car: object, inspectionRecord: object }>}
 */
export const submitInspection = (id, userId) => withTransaction(async (session) => {
  const record = await InspectionRecord.findById(id).session(session).lean();
  if (!record) throw notFound();
  if (record.status !== InspectionStatus.DRAFT) throw lockedError();

  const car = await Car.findById(record.carId).session(session);
  if (!car) throw notFound('Car');
  if (car.status !== CarStatus.UNDER_INSPECTION) {
    throw new AppError(`Car is no longer under inspection (status ${car.status}).`, 409, 'INVALID_CAR_STATUS');
  }

  const checklist = getChecklist(record.checklistVersion);
  const violations = collectSubmitViolations({
    record,
    carMileage: car.mileage,
    checklist,
    isValidImageUrl: (url) => isInspectionImageUrl(url, id),
  });
  if (violations.length) {
    throw new AppError('The inspection is incomplete and cannot be submitted.', 400, 'INSPECTION_INCOMPLETE', violations);
  }

  const groupResults = computeGroupResults(record.groups, checklist);
  const criteria = deriveCriteria(groupResults, checklist);
  const passed = evaluateCPO(criteria);
  const mileage = Number(record.vehicleInfo.confirmed.mileage);

  const { previousStatus, cpoCertificateId } = await applyVerdictToCar(car, { passed, mileage }, session);

  const submittedAt = new Date();
  const updated = await InspectionRecord.findOneAndUpdate(
    { _id: id, status: InspectionStatus.DRAFT },
    {
      $set: {
        status: InspectionStatus.SUBMITTED,
        groups: record.groups.map((group) => ({ ...group, passed: groupResults[group.groupKey] === true })),
        criteria,
        result: passed ? 'PASSED' : 'FAILED',
        odo: mileage,
        notes: summariseNotes(record.groups, checklist),
        evidenceImages: listRecordImages(record).map(({ url }) => url),
        cpoCertificateId,
        inspectorId: userId,
        submittedBy: userId,
        submittedAt,
        updatedBy: userId,
      },
    },
    { new: true, session },
  ).lean();
  if (!updated) throw lockedError(); // another submit won the race

  await logEvents(session, [
    {
      eventType: ActivityEventType.INSPECTION_SUBMITTED,
      performedBy: userId,
      targetModel: 'InspectionRecord',
      targetId: updated._id,
      summary: `Inspection submitted: ${updated.result}`,
      metadata: { carId: String(car._id), result: updated.result, cpoCertificateId },
    },
    carStatusEvent({ car, from: previousStatus, userId, inspectionId: updated._id, summary: `Inspection ${updated.result}` }),
  ]);

  return { car: car.toObject(), inspectionRecord: withLifecycleDefaults(updated) };
});

/**
 * Quick inspection (inspector or admin): records a SUBMITTED inspection from the 5 KAN-14
 * booleans (no checklist items or photos required) and applies the verdict.
 * Refused while the car has an open checklist draft. Photos must be original
 * uploads in the car's quick-inspection folder; an inspector must attach at
 * least one (an admin may record the verdict without photos).
 *
 * @param {string} carId
 * @param {string} userId - staff or admin performing the inspection
 * @param {string} role - role of the caller (SALES_STAFF or ADMIN)
 * @param {{ criteria: object, odo: number, notes?: string, evidenceImages?: string[] }} payload - Joi-validated
 * @returns {Promise<{ car: object, inspectionRecord: object }>}
 */
export const inspectCar = async (carId, userId, role, payload) => {
  const images = payload.evidenceImages || [];
  const folder = quickInspectionFolder(String(carId));
  const badImages = images
    .map((url, i) => ({ url, field: `evidenceImages.${i}` }))
    .filter(({ url }) => !isImageInFolder(url, folder));
  if (badImages.length) {
    throw new AppError('Request validation failed.', 422, 'VALIDATION_ERROR', badImages.map(({ field }) => ({
      field, message: 'Image must be uploaded to this car\'s quick-inspection folder.',
    })));
  }
  // KAN-54: INSPECTOR merged into SALES_STAFF — staff must still attach evidence photos.
  if (role === Roles.SALES_STAFF && images.length === 0) {
    throw new AppError('An inspector must attach at least one evidence photo.', 400, 'EVIDENCE_REQUIRED');
  }
  return recordQuickInspection(carId, userId, { ...payload, evidenceImages: images });
};

/** Transactional part of the quick inspection (inputs already checked). */
const recordQuickInspection = (carId, userId, payload) => withTransaction(async (session) => {
  const car = await Car.findById(carId).session(session);
  if (!car) throw notFound('Car');
  if (!INSPECTABLE_CAR_STATUSES.includes(car.status)) {
    throw new AppError(`Car cannot be inspected in status ${car.status}.`, 400, 'INVALID_CAR_STATUS');
  }
  const draft = await InspectionRecord.findOne({ carId: car._id, status: InspectionStatus.DRAFT })
    .session(session).lean();
  if (draft) throw draftExistsError(draft._id);
  if (payload.odo < Number(car.mileage || 0)) {
    throw new AppError(
      `Odometer reading (${payload.odo}) cannot be lower than the recorded mileage (${car.mileage}).`,
      400,
      'MILEAGE_DECREASE',
    );
  }

  const passed = evaluateCPO(payload.criteria);
  const { previousStatus, cpoCertificateId } = await applyVerdictToCar(car, { passed, mileage: payload.odo }, session);

  const now = new Date();
  const [record] = await InspectionRecord.create([{
    carId: car._id,
    inspectorId: userId,
    status: InspectionStatus.SUBMITTED,
    source: InspectionSource.ADMIN_QUICK,
    criteria: payload.criteria,
    odo: payload.odo,
    notes: payload.notes || '',
    evidenceImages: payload.evidenceImages || [],
    result: passed ? 'PASSED' : 'FAILED',
    cpoCertificateId,
    createdBy: userId,
    submittedBy: userId,
    submittedAt: now,
  }], { session });

  await logEvents(session, [
    {
      eventType: ActivityEventType.INSPECTION_SUBMITTED,
      performedBy: userId,
      targetModel: 'InspectionRecord',
      targetId: record._id,
      summary: `Quick inspection: ${record.result}`,
      metadata: { carId: String(car._id), result: record.result, cpoCertificateId, source: InspectionSource.ADMIN_QUICK },
    },
    carStatusEvent({ car, from: previousStatus, userId, inspectionId: record._id, summary: `Inspection ${record.result}` }),
  ]);

  return { car: car.toObject(), inspectionRecord: withLifecycleDefaults(record) };
});

export default { submitInspection, inspectCar };
