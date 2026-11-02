/**
 * @file inspectionShared.js
 * @description Helpers shared by the inspection draft and submit services:
 * which car statuses may start an inspection, writing audit entries inside a
 * transaction, and applying a CPO verdict to a car.
 */

import Car from '../models/Car.js';
import ActivityLog from '../models/ActivityLog.js';
import { ActivityEventType, CarStatus } from '../constants/appConstants.js';
import { AppError } from '../utils/apiResponse.js';
import { generateCpoCertificate } from './inspectionVerdict.js';

/** Car statuses from which a new inspection may start (re-inspection after REJECTED included). */
export const INSPECTABLE_CAR_STATUSES = Object.freeze([
  CarStatus.DRAFT,
  CarStatus.INCOMING,
  CarStatus.REJECTED,
  CarStatus.UNDER_INSPECTION,
]);

const CPO_CODE_ATTEMPTS = 3;

export const notFound = (what = 'Inspection') =>
  new AppError(`${what} not found.`, 404, what === 'Car' ? 'CAR_NOT_FOUND' : 'INSPECTION_NOT_FOUND');

export const lockedError = () =>
  new AppError('This inspection has already been submitted and can no longer be changed.', 409, 'INSPECTION_LOCKED');

export const draftExistsError = (inspectionId) => new AppError(
  'This car already has an open inspection draft.',
  409,
  'INSPECTION_DRAFT_EXISTS',
  [{ field: 'inspectionId', message: String(inspectionId) }],
);

export const isDuplicateKey = (error, field) =>
  error?.code === 11000 && (!field || Object.keys(error.keyPattern || error.keyValue || {}).includes(field));

/**
 * Writes audit entries in the same transaction as the change they describe,
 * so an audit failure rolls the change back.
 * @param {import('mongoose').ClientSession} session
 * @param {Array<object>} entries - ActivityLog documents
 */
export const logEvents = (session, entries) => ActivityLog.create(entries, { session, ordered: true });

/** Audit entry for a car status change caused by an inspection. */
export const carStatusEvent = ({ car, from, userId, inspectionId, summary }) => ({
  eventType:   ActivityEventType.CAR_STATUS_CHANGED,
  performedBy: userId,
  targetModel: 'Car',
  targetId:    car._id,
  targetCode:  car.vehicleCode || null,
  changes:     { before: { status: from }, after: { status: car.status } },
  summary,
  metadata:    { inspectionId: String(inspectionId) },
});

/** Picks a CPO code not used by any car yet; gives up after a few attempts. */
const pickUnusedCpoCode = async (session) => {
  for (let attempt = 0; attempt < CPO_CODE_ATTEMPTS; attempt += 1) {
    const code = generateCpoCertificate();
    // eslint-disable-next-line no-await-in-loop
    if (!(await Car.exists({ cpoCertificateId: code }).session(session))) return code;
  }
  throw new AppError('Could not generate a unique CPO certificate code.', 500, 'CPO_CODE_GENERATION_FAILED');
};

/**
 * Applies a verdict to a car inside a transaction: APPROVED_CPO with a new
 * certificate code, or REJECTED without one. Mileage only ever increases.
 *
 * @param {import('mongoose').Document} car
 * @param {object} params
 * @param {boolean} params.passed
 * @param {number} params.mileage - actual mileage measured during the inspection
 * @param {import('mongoose').ClientSession} session
 * @returns {Promise<{ previousStatus: string, cpoCertificateId: string|null }>}
 */
export const applyVerdictToCar = async (car, { passed, mileage }, session) => {
  const previousStatus = car.status;
  const cpoCertificateId = passed ? await pickUnusedCpoCode(session) : null;

  car.status = passed ? CarStatus.APPROVED_CPO : CarStatus.REJECTED;
  car.cpoCertificateId = cpoCertificateId;
  if (Number(mileage) > Number(car.mileage || 0)) car.mileage = Number(mileage);

  try {
    await car.save({ session });
  } catch (error) {
    if (isDuplicateKey(error, 'cpoCertificateId')) {
      throw new AppError('Could not generate a unique CPO certificate code.', 500, 'CPO_CODE_GENERATION_FAILED');
    }
    throw error;
  }
  return { previousStatus, cpoCertificateId };
};
