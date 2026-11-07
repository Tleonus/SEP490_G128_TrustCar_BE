/**
 * @file testDriveBookingService.js
 * @description Customer test-drive booking. One transaction checks the limits, picks
 * a seat and a staff member, and creates the appointment. Simultaneous bookings are
 * settled by the database: the customer document write serialises one customer's
 * requests, and the partial unique indexes on Appointment refuse a second holder of
 * the same car, staff member or seat. The loser retries and then sees the winner.
 *
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-010
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-011
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-012
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-013
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-014
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-017
 */

import Appointment from '../models/Appointment.js';
import Car from '../models/Car.js';
import Customer from '../models/Customer.js';
import { ActivityEventType, AppointmentType, TEST_DRIVE_LIMITS } from '../constants/appConstants.js';
import { AppError } from '../utils/apiResponse.js';
import { generateAppointmentCode } from '../utils/codeGenerator.js';
import { withTransaction } from '../utils/withTransaction.js';
import { getBaseSettings } from './baseSettingsService.js';
import { appointmentOverlaps, listActiveStaffIds, overlapQueryStart, pickFreeStaff } from './testDriveAssignment.js';
import { logAppointmentEvent } from './testDriveAudit.js';
import { findNearestSlots, findSlotBlocker, isCarBookable, loadHoldingAppointments, SlotBlocker } from './testDriveAvailabilityService.js';
import { assertCanBook } from './testDriveLimits.js';
import { backoff, isWriteConflict } from './testDriveRetry.js';
import { findSlotByStart, generateSlots, isWithinBookingWindow, localDayRange, toLocalDate, toLocalIso } from './testDriveSlots.js';

const BLOCKER_MESSAGES = {
  [SlotBlocker.CAR_SLOT_TAKEN]: 'This car is already booked for this time slot.',
  [SlotBlocker.SLOT_FULL]: 'This time slot is full.',
};

const CODE_COLLISION_RETRIES = 10;
const LOCATION_MAX_LENGTH = 300; // Appointment.location; the showroom name and address can be longer

const isRetryable = (error) => error.code === 11000 || isWriteConflict(error);

/** The code sequence is shared by all bookings, so a clash says nothing about this slot. */
const isCodeCollision = (error) => error.code === 11000 && Boolean(error.keyPattern?.appointmentCode);

/** Fails with the alternatives the customer can pick instead. */
const slotError = async (code, carId) => new AppError(
  BLOCKER_MESSAGES[code], 409, code, { nearestSlots: await findNearestSlots(carId) },
);

/** Lowest seat number not taken by an overlapping appointment. */
const pickSeat = (overlapping, capacity) => {
  const taken = new Set(overlapping.map((appointment) => appointment.slotSeat));
  for (let seat = 1; seat <= capacity; seat += 1) if (!taken.has(seat)) return seat;
  return null;
};

/** Validates the car and the requested time; these do not need the transaction. */
const resolveSlot = async (carId, scheduledAt) => {
  const car = await Car.findById(carId).select('status isActive').lean();
  if (!isCarBookable(car)) throw new AppError('This car cannot be booked for a test drive.', 409, 'CAR_NOT_BOOKABLE');

  const settings = await getBaseSettings();
  const slot = findSlotByStart(generateSlots(toLocalDate(scheduledAt), settings), scheduledAt);
  if (!slot) throw new AppError('The selected time is not a test-drive slot.', 422, 'INVALID_SLOT');
  if (!isWithinBookingWindow(slot.startAt)) {
    throw new AppError('Test drives must be booked 2 hours to 60 days ahead.', 422, 'SCHEDULE_OUT_OF_WINDOW');
  }
  return { slot, settings };
};

/** One booking attempt inside a transaction. */
const attemptBooking = ({ user, customerId, carId, notes, slot, settings }) => withTransaction(async (session) => {
  // Writing the customer document makes a second simultaneous request of this customer conflict.
  const touched = await Customer.updateOne({ _id: customerId }, { $set: { updatedAt: new Date() } }, { session });
  if (touched.matchedCount === 0) throw new AppError('Please complete your profile to continue.', 403, 'PROFILE_INCOMPLETE');

  await assertCanBook({ customerId, carId, session });

  const day = localDayRange(toLocalDate(slot.startAt));
  const [dayAppointments, staffIds] = await Promise.all([
    loadHoldingAppointments(overlapQueryStart(day.start), day.end, session),
    listActiveStaffIds(),
  ]);

  const capacity = settings.testDrive.maxGuestsPerSlot;
  const blocker = findSlotBlocker({ slot, carId, appointments: dayAppointments, staffIds, capacity });
  if (blocker) return { blocker };

  const overlapping = dayAppointments.filter((a) => appointmentOverlaps(a, slot.startAt, slot.endAt));
  const [appointment] = await Appointment.create([{
    appointmentCode: await generateAppointmentCode(Appointment),
    customer: customerId,
    car: carId,
    assignedTo: pickFreeStaff({ ...slot, staffIds, dayAppointments }),
    type: AppointmentType.TEST_DRIVE,
    scheduledAt: slot.startAt,
    durationMinutes: settings.testDrive.slotDurationMinutes,
    location: settings.contact.showroomDisplay.slice(0, LOCATION_MAX_LENGTH),
    notes: notes ?? null,
    slotSeat: pickSeat(overlapping, capacity),
    createdBy: user._id,
  }], { session });

  await logAppointmentEvent({
    eventType: ActivityEventType.APPOINTMENT_CREATED, appointment, actor: user, session, summary: 'Test drive booked by the customer',
  });
  return { appointment };
});

/**
 * Books a test drive for the signed-in customer.
 *
 * @param {object} params
 * @param {{_id: *, email: string, customer?: *}} params.user
 * @param {string} params.carId
 * @param {Date} params.scheduledAt
 * @param {string} [params.notes]
 * @throws {AppError} see Spec section 6
 */
export const bookOnline = async ({ user, carId, scheduledAt, notes }) => {
  if (!user.customer) throw new AppError('Please complete your profile to continue.', 403, 'PROFILE_INCOMPLETE');

  const { slot, settings } = await resolveSlot(carId, scheduledAt);
  const context = { user, customerId: user.customer, carId, notes, slot, settings };

  let attempt = 1;
  let codeCollisions = 0;
  while (attempt <= TEST_DRIVE_LIMITS.BOOKING_MAX_ATTEMPTS) {
    try {
      const { appointment, blocker } = await attemptBooking(context);
      if (blocker) throw await slotError(blocker, carId);
      return {
        id: String(appointment._id),
        appointmentCode: appointment.appointmentCode,
        carId: String(appointment.car),
        scheduledAt: toLocalIso(appointment.scheduledAt),
        durationMinutes: appointment.durationMinutes,
        location: appointment.location,
        status: appointment.status,
      };
    } catch (error) {
      if (!isRetryable(error)) throw error;
      await backoff(attempt);
      if (isCodeCollision(error) && codeCollisions < CODE_COLLISION_RETRIES) codeCollisions += 1;
      else attempt += 1;
    }
  }
  // Heavy contention: the customer picks again rather than waiting; capacity is never exceeded.
  throw await slotError(SlotBlocker.SLOT_FULL, carId);
};

export default { bookOnline };
