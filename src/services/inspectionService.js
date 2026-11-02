// src/services/inspectionService.js
/**
 * @file inspectionService.js
 * @description Digital CPO inspection checklist: create a draft for a car, save
 * it in parts, read it, issue upload signatures, and approve a CPO car for sale.
 * Submitting and the admin quick-inspect live in inspectionSubmitService.js.
 */

import Car from '../models/Car.js';
import InspectionRecord, { withLifecycleDefaults } from '../models/InspectionRecord.js';
import {
  ActivityEventType, CarStatus, InspectionSource, InspectionStatus,
} from '../constants/appConstants.js';
import { CHECKLIST_VERSION, OVERVIEW_POSITIONS, getChecklist } from '../config/inspectionChecklist.js';
import { AppError } from '../utils/apiResponse.js';
import { withTransaction } from '../utils/withTransaction.js';
import {
  buildUploadSignature, inspectionFolder, isInspectionImageUrl, quickInspectionFolder,
} from './inspectionMediaService.js';
import { listRecordImages } from './inspectionSubmitRules.js';
import {
  INSPECTABLE_CAR_STATUSES, carStatusEvent, draftExistsError, isDuplicateKey, lockedError, logEvents, notFound,
} from './inspectionShared.js';
import { evaluateCPO, generateCpoCertificate } from './inspectionVerdict.js';

// Verdict helpers live in inspectionVerdict.js; re-exported for existing importers.
export { evaluateCPO, generateCpoCertificate };
export { submitInspection, inspectCar } from './inspectionSubmitService.js';

/** Empty checklist skeleton: every item unevaluated, nothing defaults to PASS. */
const emptyGroups = (checklist) => checklist.map((group) => ({
  groupKey: group.key,
  items: group.items.map((item) => ({ itemKey: item.key, result: null, note: '', photos: [] })),
  note: '',
  photos: [],
  odometerPhoto: null,
  minorDefects: [],
  passed: null,
}));

/**
 * Creates a DRAFT inspection for a car and moves the car to UNDER_INSPECTION.
 * Vehicle details are copied from the car (original) and prefilled (confirmed).
 */
export const createDraft = async (carId, userId) => {
  try {
    return await withTransaction(async (session) => {
      const car = await Car.findById(carId).session(session);
      if (!car) throw notFound('Car');
      if (!INSPECTABLE_CAR_STATUSES.includes(car.status)) {
        throw new AppError(`Car cannot be inspected in status ${car.status}.`, 400, 'INVALID_CAR_STATUS');
      }
      const existing = await InspectionRecord.findOne({ carId: car._id, status: InspectionStatus.DRAFT })
        .session(session).lean();
      if (existing) throw draftExistsError(existing._id);

      const original = {
        make: car.make ?? null,
        model: car.model ?? null,
        variant: car.variant ?? null,
        color: car.specifications?.color ?? null,
        year: car.year ?? null,
        mileage: car.mileage ?? null,
      };
      const [record] = await InspectionRecord.create([{
        carId: car._id,
        status: InspectionStatus.DRAFT,
        source: InspectionSource.STAFF,
        checklistVersion: CHECKLIST_VERSION,
        createdBy: userId,
        updatedBy: userId,
        vehicleInfo: { original, confirmed: { ...original } },
        overviewPhotos: Object.fromEntries(OVERVIEW_POSITIONS.map((pos) => [pos, null])),
        groups: emptyGroups(getChecklist(CHECKLIST_VERSION)),
      }], { session });

      const events = [{
        eventType: ActivityEventType.INSPECTION_DRAFT_CREATED,
        performedBy: userId,
        targetModel: 'InspectionRecord',
        targetId: record._id,
        summary: 'Inspection draft created',
        metadata: { carId: String(car._id) },
      }];
      if (car.status !== CarStatus.UNDER_INSPECTION) {
        const from = car.status;
        car.status = CarStatus.UNDER_INSPECTION;
        await car.save({ session });
        events.push(carStatusEvent({ car, from, userId, inspectionId: record._id, summary: 'Inspection started' }));
      }
      await logEvents(session, events);
      return withLifecycleDefaults(record);
    });
  } catch (error) {
    // Two concurrent requests: the unique draft index rejects the second one.
    if (isDuplicateKey(error, 'carId')) {
      const existing = await InspectionRecord.findOne({ carId, status: InspectionStatus.DRAFT }).lean();
      throw draftExistsError(existing?._id ?? '');
    }
    throw error;
  }
};

/** Loads a record that must still be an open draft. */
const loadDraft = async (id) => {
  const record = await InspectionRecord.findById(id).lean();
  if (!record) throw notFound();
  if (record.status !== InspectionStatus.DRAFT) throw lockedError();
  return record;
};

/**
 * Saves part of a draft. Each section sent replaces that section entirely:
 * `vehicleInfo.confirmed`, `overviewPhotos`, and each group (matched by groupKey).
 * Concurrent editors: last write wins.
 */
export const updateDraft = async (id, userId, patch) => {
  const record = await loadDraft(id);

  const badImages = listRecordImages(patch).filter(({ url }) => !isInspectionImageUrl(url, id));
  if (badImages.length) {
    throw new AppError('Request validation failed.', 422, 'VALIDATION_ERROR', badImages.map(({ field }) => ({
      field, message: 'Image must be uploaded to this inspection\'s folder.',
    })));
  }

  const set = { updatedBy: userId };
  if (patch.vehicleInfo?.confirmed) set['vehicleInfo.confirmed'] = patch.vehicleInfo.confirmed;
  if (patch.overviewPhotos) {
    set.overviewPhotos = Object.fromEntries(OVERVIEW_POSITIONS.map((pos) => [pos, patch.overviewPhotos[pos] ?? null]));
  }
  if (patch.groups?.length) {
    const sent = new Map(patch.groups.map((group) => [group.groupKey, group]));
    set.groups = (record.groups || []).map((group) => (sent.has(group.groupKey)
      ? { ...sent.get(group.groupKey), passed: null }
      : group));
  }

  const updated = await InspectionRecord.findOneAndUpdate(
    { _id: id, status: InspectionStatus.DRAFT },
    { $set: set },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) throw lockedError(); // submitted between our read and write
  return withLifecycleDefaults(updated);
};

/** Returns any inspection record (draft or submitted, legacy included). */
export const getInspection = async (id) => {
  const record = await InspectionRecord.findById(id).lean();
  if (!record) throw notFound();
  return withLifecycleDefaults(record);
};

/** Issues a direct-upload signature bound to an open draft's folder. */
export const createUploadSignature = async (id) => {
  await loadDraft(id);
  return buildUploadSignature(inspectionFolder(String(id)));
};

/** Issues a direct-upload signature for quick-inspection photos of an inspectable car. */
export const createCarUploadSignature = async (carId) => {
  const car = await Car.findById(carId).lean();
  if (!car) throw notFound('Car');
  if (!INSPECTABLE_CAR_STATUSES.includes(car.status)) {
    throw new AppError(`Car cannot be inspected in status ${car.status}.`, 400, 'INVALID_CAR_STATUS');
  }
  return buildUploadSignature(quickInspectionFolder(String(car._id)));
};

/**
 * Approves an inspected CPO car for sale.
 * - Car must exist and be in APPROVED_CPO status.
 * - Updates status to AVAILABLE.
 *
 * @param {string} carId - Target vehicle ID
 * @returns {Promise<object>} Updated car document
 */
export const approveSale = async (carId) => {
  const car = await Car.findById(carId);
  if (!car) {
    throw new AppError('Car not found.', 404, 'CAR_NOT_FOUND');
  }

  if (car.status !== CarStatus.APPROVED_CPO) {
    throw new AppError(
      `Only cars with status APPROVED_CPO can be approved for sale. Current status: ${car.status}`,
      400,
      'INVALID_STATUS_FOR_SALE'
    );
  }

  car.status = CarStatus.AVAILABLE;
  if (!car.listedDate) {
    car.listedDate = new Date();
  }
  await car.save();

  return car;
};
