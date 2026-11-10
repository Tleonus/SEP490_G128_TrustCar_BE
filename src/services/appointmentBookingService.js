/**
 * @file appointmentBookingService.js
 * @description Creates a test-drive visit (1..3 cars, one fixed slot) safely under
 * concurrency using "save, then re-check":
 *
 *   1. pure time checks (no DB)  2. load bookable cars  3. pre-check rules
 *   4. write N appointments      5. re-check with the SAME rules (ignoring my rows)
 *   6. on violation: hide my rows (isActive=false) and fail — all or nothing.
 *
 * Two concurrent requests can never both succeed (they may both fail); see
 * `appointmentBookingRules.js` and the exhaustive simulation in the tests.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-003…012, 023; C9, C15)
 */

import { AppointmentType, AppointmentStatus } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import {
  VISIT_DURATION_MIN, SHOWROOM_LOCATION, RACE_LOST_REASON, ABORTED_REASON,
} from '../constants/appointmentRules.js';
import { fail } from './appointmentErrors.js';
import { assertBookableTime } from './appointmentSlotRules.js';
import { violationToError } from './appointmentBookingRules.js';
import { findBookableCars } from './appointmentQueries.js';
import { violationNow, insertWithCode, hideRows } from './appointmentWrite.js';
import { groupIntoVisits, customerExtras } from './appointmentVisitRules.js';
import { toCustomerVisit } from './appointmentVisitMapper.js';
import { logAppointmentEvents } from './appointmentAudit.js';
import { MailEvent } from './appointmentMailTemplates.js';
import { dispatchMail, describeVisit } from './appointmentMailService.js';

const writeRows = async ({ customerId, userId, carIds, scheduledAt, notes }, extra, written) => {
  for (const car of carIds) {
    written.push(await insertWithCode({
      customer: customerId,
      car,
      type: AppointmentType.TEST_DRIVE,
      scheduledAt,
      durationMinutes: VISIT_DURATION_MIN,
      location: SHOWROOM_LOCATION,
      notes: notes?.trim() ? notes.trim() : null,
      createdBy: userId,
      ...extra,
    }));
  }
};

/**
 * The booking core shared by customers (`createVisit`) and staff (`createVisitForCustomer`):
 * time rule of the actor → cars still for sale → pre-check → write → re-check → all or nothing.
 * Only the actor's time rule and the extra fields of the new rows differ between them, so the
 * concurrency argument (appointmentBookingRules.js) is the same for both.
 *
 * @param {object} p  `{ userId, customerId, carIds, scheduledAt, notes?, now? }`
 * @param {object} [options]
 * @param {Function} [options.assertTime]  Throws when the time is not bookable (default: the customer rule).
 * @param {object} [options.extra]         Extra fields for every new row (e.g. status CONFIRMED for staff).
 * @returns {Promise<{ written: object[], cars: object[] }>}
 */
export const bookRows = async (p, { assertTime = assertBookableTime, extra = {} } = {}) => {
  const { userId, customerId, carIds, scheduledAt, now = new Date() } = p;
  assertTime(scheduledAt, now);

  const cars = await findBookableCars(carIds);
  if (cars.length !== carIds.length) throw fail(MSG.MSG61); // C14: no distinction of the cause

  const rule = { customerId, carIds, scheduledAt, now };
  const before = await violationNow({ ...rule, mine: [] });
  if (before) throw violationToError(before, scheduledAt);

  const written = [];
  let after;
  try {
    await writeRows(p, extra, written);
    after = await violationNow({ ...rule, mine: written.map((row) => row._id) });
  } catch (error) {
    await hideRows(written, userId, ABORTED_REASON); // a write or the re-check failed: leave nothing behind
    throw error;
  }
  if (after) {
    await hideRows(written, userId, RACE_LOST_REASON); // lost the race: all or nothing
    throw violationToError(after, scheduledAt);
  }
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
