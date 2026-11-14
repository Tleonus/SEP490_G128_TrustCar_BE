/**
 * @file appointmentRescheduleService.js
 * @description Moves a visit (all of its OPEN appointments, same cars) to another slot, in ONE
 * transaction:
 *
 *   outside:  who may move it · time rules · cars still for sale · slot capacity
 *   inside :  touch the customer · re-read the visit (it must still be exactly what the caller saw)
 *             · read the new slot · rule check ignoring the visit's own rows · pick the seat ·
 *             hide the old rows (`RESCHEDULED:<new code>`, holds released) · write the new rows
 *
 * Old rows are hidden, not deleted: the "how many times was this visit moved" count follows the
 * `RESCHEDULED:` reasons (appointmentRescheduleChain.js). They are hidden and their holds released
 * in the same transaction that creates the new rows, so the customer never holds two slots or
 * none, and two requests moving or cancelling the same visit end in exactly one outcome (the
 * second re-reads, finds the visit changed and answers 409; a write conflict is retried).
 * If anything fails the transaction rolls back: the old visit is untouched.
 *
 * Ref: .sdd/features/test-drive-capacity-guard/SPEC.md (REQ-210, REQ-216, AC-17);
 *      .sdd/features/test-drive-booking/SPEC.md (REQ-031…034, 041, C16–C18, C27, C29)
 */

import { AppointmentStatus } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { OPEN_STATUSES, RESCHEDULED_PREFIX } from '../constants/appointmentRules.js';
import Appointment from '../models/Appointment.js';
import Customer from '../models/Customer.js';
import { withTransaction } from '../utils/withTransaction.js';
import { fail } from './appointmentErrors.js';
import { assertBookableTime, assertStaffBookableTime } from './appointmentSlotRules.js';
import { Violation, violationToError, evaluateBooking } from './appointmentBookingRules.js';
import {
  findVisitRowsByAnyId, loadVisitContext, findOpenAtSlot, findCustomerOpen, findVisitRows, plain,
} from './appointmentQueries.js';
import { allocateCodes } from './appointmentWrite.js';
import { getSlotCapacity } from './appointmentCapacity.js';
import { RELEASE_HOLDS, holdFields, pickVisitSeat } from './appointmentHolds.js';
import { runWithRetry } from './appointmentTransaction.js';
import {
  groupIntoVisits, isOpenRow, rescheduleBlock, visitCodeOf, customerExtras, needsReminderCall, needsOutcome,
} from './appointmentVisitRules.js';
import { countReschedules } from './appointmentRescheduleChain.js';
import { assertCarsSellable } from './appointmentReconcileService.js';
import { toCustomerVisit, toStaffVisit } from './appointmentVisitMapper.js';
import { logRescheduled } from './appointmentAudit.js';
import { MailEvent } from './appointmentMailTemplates.js';
import { dispatchMail, describeVisit } from './appointmentMailService.js';
import { Actor, replacementOf } from './appointmentRescheduleSettle.js';
import { isNewRequest } from './appointmentStaffOrder.js';

const loadVisit = async (id, customerId = null) => {
  const rows = await findVisitRowsByAnyId(id, { customerId });
  if (rows.length === 0) throw fail(MSG.MSG38);
  return groupIntoVisits(rows)[0];
};

const sameIds = (rows, ids) => rows.length === ids.length && rows.every((row) => ids.includes(String(row._id)));

/**
 * One try of the move transaction. Throws a business error (nothing changes) or returns the new rows.
 */
const moveInTransaction = async (session, { visit, open, scheduledAt, actor, userId, now, capacity }) => {
  // Same customer → requests queue up (a concurrent move/cancel/booking conflicts here and is retried).
  const touched = await Customer.updateOne({ _id: visit.customer }, { $set: { updatedAt: new Date() } }, { session });
  if (touched.matchedCount === 0) throw fail(MSG.MSG31);

  // The visit must still be exactly what the caller saw: every row open, none added or closed.
  const oldIds = open.map((row) => String(row._id));
  const current = (await findVisitRows(visit.customer, visit.scheduledAt, { session })).filter(isOpenRow);
  if (!sameIds(current, oldIds)) throw fail(MSG.MSG81);

  const slotRows = await findOpenAtSlot(scheduledAt, { session });
  const customerRows = await findCustomerOpen(visit.customer, now, { session });
  const carIds = open.map((row) => String(row.car));
  const violation = evaluateBooking({
    slotRows, customerRows, customerId: visit.customer, carIds, scheduledAt, now, capacity, mine: oldIds,
  });
  if (violation) throw violationToError(violation, scheduledAt);

  const seat = pickVisitSeat(slotRows, capacity);
  if (seat === null) throw fail(MSG.MSG83); // cannot happen when the rule check passed; kept as a guard
  const codes = await allocateCodes(open.length);

  // Old rows first: hidden, marked with the new visit code, holds released — all in this transaction.
  const retired = await Appointment.updateMany(
    { _id: { $in: open.map((row) => row._id) }, status: { $in: OPEN_STATUSES }, isActive: true },
    {
      $set: {
        status: AppointmentStatus.CANCELLED, isActive: false, cancellationReason: `${RESCHEDULED_PREFIX}${codes[0]}`, updatedBy: userId,
      },
      $unset: RELEASE_HOLDS,
    },
    { session },
  );
  if (retired.modifiedCount !== open.length) throw fail(MSG.MSG81);

  const docs = open.map((old, index) => ({
    ...replacementOf(old, { actor, userId, now, scheduledAt }),
    appointmentCode: codes[index],
    ...holdFields({ lead: index === 0, seat }), // codes count up, so row 0 has the lowest code
  }));
  const created = await Appointment.create(docs, { session, ordered: true });
  return created.map(plain);
};

/** The shared core. Every access/time rule of the actor has been checked by the caller. */
const moveVisit = async ({ visit, scheduledAt, actor, userId, ipAddress, now }) => {
  const open = visit.rows.filter(isOpenRow);
  if (scheduledAt.getTime() === visit.scheduledAt.getTime()) throw violationToError({ kind: Violation.DUPLICATE_SLOT }, scheduledAt);

  const carIds = open.map((row) => String(row.car));
  const cars = await assertCarsSellable(carIds, { userId, ipAddress });

  const capacity = await getSlotCapacity();
  const written = await runWithRetry(() => withTransaction((session) =>
    moveInTransaction(session, { visit, open, scheduledAt, actor, userId, now, capacity })));

  const newCode = visitCodeOf(written);
  const previousVisitCode = visitCodeOf(visit.rows);
  await logRescheduled({ newRows: written, previousCode: previousVisitCode, newCode, fromAt: visit.scheduledAt, toAt: scheduledAt, userId, ipAddress });
  const carsById = new Map(cars.map((car) => [String(car._id), car]));
  dispatchMail({
    event: MailEvent.RESCHEDULED,
    customerId: visit.customer,
    data: {
      ...describeVisit(written, carsById),
      previousVisitCode,
      previousScheduledAt: visit.scheduledAt,
      needsConfirmation: written[0].status === AppointmentStatus.PENDING,
    },
  });
  return { newVisit: groupIntoVisits(written)[0], previousVisitCode, carsById };
};

/**
 * A customer moves their own visit (still ≥ 12 hours away, at most twice).
 *
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-031
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-032
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-033
 * @param {object} p
 * @param {string} p.customerId  `user.customer`.
 * @param {string} p.userId      The customer's user (recorded as the actor).
 * @param {string} p.id          Any appointment id of the visit.
 * @param {Date} p.scheduledAt   The new slot.
 * @returns {Promise<{ visit: object, previousVisitCode: string }>}
 */
export const rescheduleMyVisit = async ({ customerId, userId, id, scheduledAt, ipAddress, now = new Date() }) => {
  if (!customerId) throw fail(MSG.MSG31);
  const visit = await loadVisit(id, customerId);
  if (rescheduleBlock(visit, 0, now) === 'NOT_ALLOWED') throw fail(MSG.MSG85);
  const count = (await countReschedules([visit])).get(visit.visitId);
  if (rescheduleBlock(visit, count, now) === 'LIMIT') throw fail(MSG.MSG86);
  assertBookableTime(scheduledAt, now);

  const { newVisit, previousVisitCode, carsById } = await moveVisit({
    visit, scheduledAt, actor: Actor.CUSTOMER, userId, ipAddress, now,
  });
  return { visit: toCustomerVisit(newVisit, carsById, customerExtras(newVisit, count + 1, now)), previousVisitCode };
};

/**
 * Staff move a customer's visit (no 12-hour rule, no limit on moves, no 2-hour lead time; the
 * old time may even have passed). Capacity, car and customer limits still apply.
 *
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-034
 * @param {object} p
 * @param {string} p.id  Any appointment id of the visit.
 * @param {string} p.userId  Staff user.
 * @param {Date} p.scheduledAt
 * @returns {Promise<{ visit: object, previousVisitCode: string }>}
 */
export const rescheduleVisitAsStaff = async ({ id, userId, scheduledAt, ipAddress, now = new Date() }) => {
  const visit = await loadVisit(id);
  if (!visit.rows.some(isOpenRow)) throw fail(MSG.MSG85);
  assertStaffBookableTime(scheduledAt, now);

  const { newVisit, previousVisitCode } = await moveVisit({
    visit, scheduledAt, actor: Actor.STAFF, userId, ipAddress, now,
  });
  const [context, counts] = await Promise.all([loadVisitContext([newVisit], { staff: true }), countReschedules([newVisit])]);
  return {
    visit: toStaffVisit(newVisit, context.carsById, context.customersById, context.usersById, {
      rescheduleCount: counts.get(newVisit.visitId),
      needsReminderCall: needsReminderCall(newVisit, now),
      needsOutcome: needsOutcome(newVisit, now),
      isNewRequest: isNewRequest(newVisit, now),
    }),
    previousVisitCode,
  };
};

export default { rescheduleMyVisit, rescheduleVisitAsStaff };
