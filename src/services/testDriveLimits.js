/**
 * @file testDriveLimits.js
 * @description Per-customer booking limits. Counts run inside the booking
 * transaction, which already writes the customer document, so two simultaneous
 * requests of one customer cannot both pass on the same counts.
 *
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-015
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-016
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-043
 */

import Appointment from '../models/Appointment.js';
import { AppError } from '../utils/apiResponse.js';
import { AppointmentStatus, AppointmentType, TEST_DRIVE_ACTIVE_STATUSES, TEST_DRIVE_LIMITS as LIMITS } from '../constants/appConstants.js';
import { localDayRange, toLocalDate } from './testDriveSlots.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * When a customer's online-booking lock ends.
 * @param {Date[]} noShowTimes - Scheduled times of no-shows, most recent first.
 * @param {Date} now
 * @returns {Date|null} end of the lock, or null when not locked
 */
export const computeLockedUntil = (noShowTimes, now) => {
  if (noShowTimes.length < LIMITS.NO_SHOWS_TO_LOCK) return null;
  const [latest, previous] = noShowTimes;
  if (latest.getTime() - previous.getTime() > LIMITS.WINDOW_DAYS * MS_PER_DAY) return null;
  const lockedUntil = new Date(latest.getTime() + LIMITS.LOCK_DAYS * MS_PER_DAY);
  return lockedUntil > now ? lockedUntil : null;
};

const limitError = (code, message) => new AppError(message, 409, code);

/**
 * @param {object} params
 * @param {string} params.customerId
 * @param {string} params.carId
 * @param {import('mongoose').ClientSession} params.session
 * @throws {AppError} 403 BOOKING_LOCKED; 409 ACTIVE_BOOKING_LIMIT, CAR_BOOKING_LIMIT, DAILY_BOOKING_LIMIT, COMPLETED_LIMIT
 */
export const assertCanBook = async ({ customerId, carId, session }) => {
  const now = new Date();
  const base = { customer: customerId, type: AppointmentType.TEST_DRIVE };
  const count = (filter) => Appointment.countDocuments({ ...base, ...filter }).session(session);

  const noShows = await Appointment.find({ ...base, status: AppointmentStatus.NO_SHOW })
    .select('scheduledAt').sort({ scheduledAt: -1 }).limit(LIMITS.NO_SHOWS_TO_LOCK).session(session).lean();
  const lockedUntil = computeLockedUntil(noShows.map((noShow) => noShow.scheduledAt), now);
  if (lockedUntil) {
    throw new AppError('Online booking is locked after repeated no-shows.', 403, 'BOOKING_LOCKED', { lockedUntil: lockedUntil.toISOString() });
  }

  const upcoming = { status: { $in: TEST_DRIVE_ACTIVE_STATUSES }, scheduledAt: { $gt: now } };
  if (await count(upcoming) >= LIMITS.MAX_ACTIVE_BOOKINGS) {
    throw limitError('ACTIVE_BOOKING_LIMIT', 'You already have the maximum number of upcoming test drives.');
  }
  if (await count({ ...upcoming, car: carId }) >= LIMITS.MAX_ACTIVE_PER_CAR) {
    throw limitError('CAR_BOOKING_LIMIT', 'You already have an upcoming test drive for this car.');
  }

  const today = localDayRange(toLocalDate(now));
  if (await count({ createdAt: { $gte: today.start, $lt: today.end } }) >= LIMITS.MAX_BOOKINGS_PER_DAY) {
    throw limitError('DAILY_BOOKING_LIMIT', 'You have reached the number of bookings allowed today.');
  }

  const windowStart = new Date(now.getTime() - LIMITS.WINDOW_DAYS * MS_PER_DAY);
  if (await count({ status: AppointmentStatus.COMPLETED, completedAt: { $gte: windowStart } }) >= LIMITS.MAX_COMPLETED_IN_WINDOW) {
    throw limitError('COMPLETED_LIMIT', 'You have reached the number of completed test drives allowed in 30 days.');
  }
};

export default { assertCanBook, computeLockedUntil };
