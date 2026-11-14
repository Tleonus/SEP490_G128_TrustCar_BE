/**
 * @file appointmentBookingService.js
 * @description Creates a test-drive visit (1..3 cars, one fixed slot) inside ONE transaction:
 *
 *   outside:  pure time checks · cars still for sale · slot capacity (Admin setting)
 *   inside :  touch the customer (their requests queue up) · read the slot and the customer's
 *             open rows · rule check · pick the visit's seat · write every row
 *   retry  :  a write conflict or a car/seat clash re-runs the whole transaction, which then sees
 *             the winner and answers with the proper business error (appointmentTransaction.js)
 *
 * All or nothing: if any step fails the transaction is rolled back, so NO row (not even a hidden
 * one) is left behind. The unique indexes `uniq_visit_car_time` / `uniq_visit_seat_time`
 * (appointmentHoldIndexes.js) are the last line of defence for requests of DIFFERENT customers.
 *
 * Ref: .sdd/features/test-drive-capacity-guard/SPEC.md (REQ-210…213, AC-10…14, 18)
 */

import { AppointmentType, AppointmentStatus } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { VISIT_DURATION_MIN, SHOWROOM_LOCATION } from '../constants/appointmentRules.js';
import Appointment from '../models/Appointment.js';
import Customer from '../models/Customer.js';
import { withTransaction } from '../utils/withTransaction.js';
import { fail } from './appointmentErrors.js';
import { assertBookableTime } from './appointmentSlotRules.js';
import { evaluateBooking, violationToError } from './appointmentBookingRules.js';
import { findBookableCars, findOpenAtSlot, findCustomerOpen, plain } from './appointmentQueries.js';
import { allocateCodes } from './appointmentWrite.js';
import { getSlotCapacity } from './appointmentCapacity.js';
import { holdFields, pickVisitSeat } from './appointmentHolds.js';
import { runWithRetry } from './appointmentTransaction.js';
import { groupIntoVisits, customerExtras } from './appointmentVisitRules.js';
import { toCustomerVisit } from './appointmentVisitMapper.js';
import { logAppointmentEvents } from './appointmentAudit.js';
import { MailEvent } from './appointmentMailTemplates.js';
import { dispatchMail, describeVisit } from './appointmentMailService.js';

/**
 * One try of the booking transaction. Throws a business error (nothing is written) or returns
 * the rows it created. Reads and writes use `session`; the reads are sequential because one
 * transaction session cannot run two operations at once.
 */
const bookInTransaction = async (session, { userId, customerId, carIds, scheduledAt, notes, now }, { extra, capacity }) => {
  // Writing the customer's document makes two requests of the same customer collide, so they run one after the other.
  const touched = await Customer.updateOne({ _id: customerId }, { $set: { updatedAt: new Date() } }, { session });
  if (touched.matchedCount === 0) throw fail(MSG.MSG31);

  const slotRows = await findOpenAtSlot(scheduledAt, { session });
  const customerRows = await findCustomerOpen(customerId, now, { session });
  const violation = evaluateBooking({ slotRows, customerRows, customerId, carIds, scheduledAt, now, capacity, mine: [] });
  if (violation) throw violationToError(violation, scheduledAt);

  const seat = pickVisitSeat(slotRows, capacity);
  if (seat === null) throw fail(MSG.MSG83); // cannot happen when the rule check passed; kept as a guard
  const codes = await allocateCodes(carIds.length);

  const docs = carIds.map((car, index) => ({
    customer: customerId,
    car,
    type: AppointmentType.TEST_DRIVE,
    scheduledAt,
    durationMinutes: VISIT_DURATION_MIN,
    location: SHOWROOM_LOCATION,
    notes: notes?.trim() ? notes.trim() : null,
    createdBy: userId,
    ...extra,
    appointmentCode: codes[index],
    ...holdFields({ lead: index === 0, seat }), // codes count up, so row 0 has the lowest code
  }));
  const created = await Appointment.create(docs, { session, ordered: true });
  return created.map(plain);
};

/**
 * The booking core shared by customers (`createVisit`) and staff (`createVisitForCustomer`):
 * time rule of the actor → cars still for sale → one transaction (see the file header). Only the
 * actor's time rule and the extra fields of the new rows differ between them.
 *
 * @param {object} p  `{ userId, customerId, carIds, scheduledAt, notes?, now? }`
 * @param {object} [options]
 * @param {Function} [options.assertTime]  Throws when the time is not bookable (default: the customer rule).
 * @param {object} [options.extra]         Extra fields for every new row (e.g. status CONFIRMED for staff).
 * @returns {Promise<{ written: object[], cars: object[] }>}
 */
export const bookRows = async (p, { assertTime = assertBookableTime, extra = {} } = {}) => {
  const { carIds, scheduledAt, now = new Date() } = p;
  assertTime(scheduledAt, now);

  const cars = await findBookableCars(carIds);
  if (cars.length !== carIds.length) throw fail(MSG.MSG61); // C14: no distinction of the cause

  const capacity = await getSlotCapacity();
  const written = await runWithRetry(() => withTransaction((session) =>
    bookInTransaction(session, { ...p, now }, { extra, capacity })));
  return { written, cars };
};

/**
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-003
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-005
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-012
 * @param {object} p
 * @param {string} p.userId       Booking user (`createdBy`).
 * @param {string} p.customerId   `user.customer`; missing → 404 CUSTOMER_NOT_FOUND (C13).
 * @param {string[]} p.carIds     1..3 distinct car ids (already validated by the route).
 * @param {Date}   p.scheduledAt
 * @param {string} [p.notes]
 * @param {string} [p.ipAddress]
 * @param {Date}   [p.now]
 * @returns {Promise<object>} Customer view of the created visit.
 */
export const createVisit = async (p) => {
  const { userId, customerId, ipAddress, now = new Date() } = p;
  if (!customerId) throw fail(MSG.MSG31);
  const { written, cars } = await bookRows(p);

  try {
    await logAppointmentEvents(written, { status: AppointmentStatus.PENDING, userId, ipAddress });
  } catch (error) {
    console.error('Appointment audit log failed:', error.message);
  }
  const carsById = new Map(cars.map((car) => [String(car._id), car]));
  dispatchMail({ event: MailEvent.CREATED, customerId, data: describeVisit(written, carsById) });
  const visit = groupIntoVisits(written)[0];
  return toCustomerVisit(visit, carsById, customerExtras(visit, 0, now)); // brand new: never moved
};

export default { createVisit, bookRows };
