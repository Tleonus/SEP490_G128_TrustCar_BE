/**
 * @file testDriveAvailabilityService.js
 * @description Which slots of a car can still be booked. Loads a day's or a week's
 * appointments in one query, so the query count does not grow with the slot count.
 *
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-007
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-008
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-009
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-014
 */

import Car from '../models/Car.js';
import Appointment from '../models/Appointment.js';
import { AppError } from '../utils/apiResponse.js';
import { AppointmentType, CarStatus, TEST_DRIVE_ACTIVE_STATUSES, TEST_DRIVE_LIMITS } from '../constants/appConstants.js';
import { getBaseSettings } from './baseSettingsService.js';
import { addLocalDays, generateSlots, isWithinBookingWindow, localDayRange, toLocalDate, toLocalIso } from './testDriveSlots.js';
import { appointmentOverlaps, listActiveStaffIds, overlapQueryStart, pickFreeStaff } from './testDriveAssignment.js';

export const SlotBlocker = Object.freeze({ CAR_SLOT_TAKEN: 'CAR_SLOT_TAKEN', SLOT_FULL: 'SLOT_FULL' });

/** Whether a car can be booked at all. */
export const isCarBookable = (car) => Boolean(car && car.status === CarStatus.AVAILABLE && car.isActive);

/** Holding appointments whose start falls in a range, seen through `session` when given. */
export const loadHoldingAppointments = (from, to, session = null) => {
  const query = Appointment.find({
    type: AppointmentType.TEST_DRIVE,
    status: { $in: TEST_DRIVE_ACTIVE_STATUSES },
    scheduledAt: { $gte: from, $lt: to },
  }).select('car assignedTo scheduledAt durationMinutes slotSeat');
  return (session ? query.session(session) : query).lean();
};

/**
 * Why a slot cannot take this car, ignoring the booking window.
 * @returns {string|null} a SlotBlocker value, or null when free
 */
export const findSlotBlocker = ({ slot, carId, appointments, staffIds, capacity }) => {
  const overlapping = appointments.filter((a) => appointmentOverlaps(a, slot.startAt, slot.endAt));
  if (overlapping.some((a) => String(a.car) === String(carId))) return SlotBlocker.CAR_SLOT_TAKEN;
  if (overlapping.length >= capacity) return SlotBlocker.SLOT_FULL;
  const staffId = pickFreeStaff({ ...slot, staffIds, dayAppointments: overlapping });
  return staffId ? null : SlotBlocker.SLOT_FULL;
};

const toSlotView = (slot) => ({ startAt: toLocalIso(slot.startAt), endAt: toLocalIso(slot.endAt) });

/**
 * Every slot of a car on a date with its availability.
 * @param {string} carId
 * @param {string} date - Local date, YYYY-MM-DD.
 * @throws {AppError} 404 CAR_NOT_BOOKABLE
 */
export const getCarSlots = async (carId, date) => {
  const car = await Car.findById(carId).select('status isActive').lean();
  if (!isCarBookable(car)) throw new AppError('This car cannot be booked for a test drive.', 404, 'CAR_NOT_BOOKABLE');

  const settings = await getBaseSettings();
  const slots = generateSlots(date, settings);
  if (slots.length === 0) return [];

  const now = new Date();
  const [appointments, staffIds] = await Promise.all([
    loadHoldingAppointments(overlapQueryStart(slots[0].startAt), slots[slots.length - 1].endAt),
    listActiveStaffIds(),
  ]);

  return slots.map((slot) => ({
    ...toSlotView(slot),
    available: isWithinBookingWindow(slot.startAt, now) && !findSlotBlocker({
      slot, carId, appointments, staffIds, capacity: settings.testDrive.maxGuestsPerSlot,
    }),
  }));
};

/**
 * The closest free slots of a car in the coming days, offered when a booking fails.
 * @param {string} carId
 * @returns {Promise<Array<{startAt: string, endAt: string}>>}
 */
export const findNearestSlots = async (carId) => {
  const now = new Date();
  const settings = await getBaseSettings();
  const today = toLocalDate(now);
  const days = Array.from({ length: TEST_DRIVE_LIMITS.NEAREST_SLOTS_DAYS + 1 }, (_, i) => addLocalDays(today, i));

  const [appointments, staffIds] = await Promise.all([
    loadHoldingAppointments(overlapQueryStart(now), localDayRange(days[days.length - 1]).end),
    listActiveStaffIds(),
  ]);

  return days
    .flatMap((date) => generateSlots(date, settings))
    .filter((slot) => isWithinBookingWindow(slot.startAt, now) && !findSlotBlocker({
      slot, carId, appointments, staffIds, capacity: settings.testDrive.maxGuestsPerSlot,
    }))
    .slice(0, TEST_DRIVE_LIMITS.NEAREST_SLOTS)
    .map(toSlotView);
};

export default { getCarSlots, findNearestSlots, findSlotBlocker, isCarBookable, loadHoldingAppointments, SlotBlocker };
