/**
 * @file appointmentAddCarService.js
 * @description A customer adds cars to their own visit while it is still waiting for confirmation
 * (every open appointment PENDING). Same slot, same visit code, at most MAX_CARS_PER_VISIT open cars.
 *
 *   outside:  own visit · still PENDING · room for the cars · not already in it · time still bookable
 *             · cars still for sale
 *   inside :  touch the customer · re-read the visit and stamp its rows (a concurrent staff confirm,
 *             cancel or move conflicts here and the transaction is retried, then refused) · rule check
 *             ignoring the visit's own rows · write the new rows
 *
 * The new rows carry the visit's own `createdAt`, so they belong to the same booking batch
 * (`groupIntoVisits` splits bookings of one slot by creation time) and the visit keeps its code,
 * its id and its reschedule count. They hold their car (`holdsCar`) but no seat: the visit already
 * has one, so the slot capacity is not judged again.
 *
 * No e-mail is sent: the visit is still unconfirmed and the confirmation mail lists every car.
 */

import { AppointmentType, AppointmentStatus } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { MAX_CARS_PER_VISIT } from '../constants/appointmentRules.js';
import Appointment from '../models/Appointment.js';
import Customer from '../models/Customer.js';
import { withTransaction } from '../utils/withTransaction.js';
import { fail } from './appointmentErrors.js';
import { assertBookableTime } from './appointmentSlotRules.js';
import { evaluateBooking, violationToError } from './appointmentBookingRules.js';
import {
  findBookableCars, findCustomerOpen, findOpenAtSlot, findVisitRows, findVisitRowsByAnyId, plain,
} from './appointmentQueries.js';
import { allocateCodes } from './appointmentWrite.js';
import { holdFields } from './appointmentHolds.js';
import { runWithRetry } from './appointmentTransaction.js';
import { groupIntoVisits, isOpenRow, visitContaining, bookedAtOf } from './appointmentVisitRules.js';
import { logAppointmentEvents } from './appointmentAudit.js';
import { getMyVisit } from './appointmentCustomerService.js';

const { PENDING } = AppointmentStatus;
const idOf = (value) => String(value);
const sameIds = (rows, ids) => rows.length === ids.length && rows.every((row) => ids.includes(idOf(row._id)));

/** Why cars cannot be added to this visit (checked before and again inside the transaction). */
const assertAddable = (open, carIds) => {
  if (open.length === 0 || open.some((row) => row.status !== PENDING)) throw fail(MSG.MSG87);
  if (open.length + carIds.length > MAX_CARS_PER_VISIT) throw fail(MSG.MSG88);
  const inVisit = new Set(open.map((row) => idOf(row.car)));
  const already = carIds.filter((carId) => inVisit.has(idOf(carId)));
  if (already.length > 0) throw fail(MSG.MSG82, { carIds: already });
};

const addInTransaction = async (session, { visit, open, carIds, userId, now }) => {
  const touched = await Customer.updateOne({ _id: visit.customer }, { $set: { updatedAt: new Date() } }, { session });
  if (touched.matchedCount === 0) throw fail(MSG.MSG31);

  const openIds = open.map((row) => idOf(row._id));
  const current = (await findVisitRows(visit.customer, visit.scheduledAt, { session })).filter(isOpenRow);
  if (!sameIds(current, openIds)) throw fail(MSG.MSG81);
  assertAddable(current, carIds);
  // Writing the visit's rows makes a concurrent confirm / cancel / move of this visit collide with us.
  const stamped = await Appointment.updateMany(
    { _id: { $in: open.map((row) => row._id) }, status: PENDING, isActive: true },
    { $set: { updatedBy: userId } },
    { session },
  );
  if (stamped.matchedCount !== open.length) throw fail(MSG.MSG87);

  const slotRows = await findOpenAtSlot(visit.scheduledAt, { session });
  const customerRows = await findCustomerOpen(visit.customer, now, { session });
  const violation = evaluateBooking({
    slotRows, customerRows, customerId: visit.customer, carIds, scheduledAt: visit.scheduledAt, now,
    mine: openIds, capacity: Number.POSITIVE_INFINITY, // the visit already holds its seat
  });
  if (violation) throw violationToError(violation, visit.scheduledAt);

  const lead = open[0];
  const codes = await allocateCodes(carIds.length);
  const docs = carIds.map((car, index) => ({
    customer: visit.customer,
    car,
    type: AppointmentType.TEST_DRIVE,
    status: PENDING,
    scheduledAt: visit.scheduledAt,
    durationMinutes: lead.durationMinutes,
    location: lead.location,
    notes: lead.notes ?? null,
    createdBy: lead.createdBy ?? userId,
    createdAt: bookedAtOf(visit.rows),
    appointmentCode: codes[index],
    ...holdFields({ lead: false, seat: null }),
  }));
  const created = await Appointment.create(docs, { session, ordered: true });
  return created.map(plain);
};

/**
 * @param {object} p
 * @param {string} p.customerId  `user.customer`.
 * @param {string} p.userId
 * @param {string} p.id          Any appointment id of the visit.
 * @param {string[]} p.carIds    1..3 distinct car ids (validated by the route).
 * @returns {Promise<object>} Customer view of the visit with the new cars.
 */
export const addCarsToMyVisit = async ({ customerId, userId, id, carIds, ipAddress, now = new Date() }) => {
  if (!customerId) throw fail(MSG.MSG31);
  const rows = await findVisitRowsByAnyId(id, { customerId });
  if (rows.length === 0) throw fail(MSG.MSG38);
  const visit = visitContaining(groupIntoVisits(rows), id);
  const open = visit.rows.filter(isOpenRow);
  assertAddable(open, carIds);
  assertBookableTime(visit.scheduledAt, now);

  const cars = await findBookableCars(carIds);
  if (cars.length !== carIds.length) throw fail(MSG.MSG61);

  const written = await runWithRetry(() => withTransaction((session) =>
    addInTransaction(session, { visit, open, carIds, userId, now })));

  try {
    await logAppointmentEvents(written, { status: PENDING, userId, ipAddress });
  } catch (error) {
    console.error('Appointment audit log failed:', error.message);
  }
  return getMyVisit({ customerId, id: visit.visitId, now });
};

export default { addCarsToMyVisit };
