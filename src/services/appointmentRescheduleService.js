/**
 * @file appointmentRescheduleService.js
 * @description Moves a visit (all of its OPEN appointments, same cars) to another slot.
 *
 * Why "create new, check, then hide old" and not "edit the time in place":
 *   editing in place and undoing on a lost race could fail after another request already took
 *   the old slot, leaving the customer with nothing. Here the old visit stays untouched until
 *   the new one has PROVEN it fits, so a customer never ends with zero or two open visits
 *   (INV-10).
 *
 *   1. checks that need no write      (who may move it, time rules, cars still for sale)
 *   2. pre-check with the booking rules, ignoring the visit being moved
 *   3. write the new appointments (fresh APT codes; the visit gets a NEW code — Spec C16)
 *   4. re-check (ignoring the old rows and the new rows)  → lost the race: hide the new rows
 *   5. hide the old rows with a compare-and-set on "still open"
 *        all of them changed → done
 *        none / only some    → undo (hide the new rows, restore the old ones) and answer 409;
 *                              this is what makes two concurrent moves of one visit, or a move
 *                              racing a cancel, end in exactly one outcome (INV-11).
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-031…034, 041, C16–C18, C27, C29, INV-10/11)
 */

import { AppointmentStatus } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { RACE_LOST_REASON, ABORTED_REASON } from '../constants/appointmentRules.js';
import { fail } from './appointmentErrors.js';
import { assertBookableTime, assertStaffBookableTime } from './appointmentSlotRules.js';
import { Violation, violationToError } from './appointmentBookingRules.js';
import { findVisitRowsByAnyId, loadVisitContext } from './appointmentQueries.js';
import { violationNow, insertWithCode, hideRows } from './appointmentWrite.js';
import {
  groupIntoVisits, isOpenRow, rescheduleBlock, visitCodeOf, customerExtras, needsReminderCall, needsOutcome,
} from './appointmentVisitRules.js';
import { countReschedules } from './appointmentRescheduleChain.js';
import { assertCarsSellable } from './appointmentReconcileService.js';
import { toCustomerVisit, toStaffVisit } from './appointmentVisitMapper.js';
import { logRescheduled } from './appointmentAudit.js';
import { MailEvent } from './appointmentMailTemplates.js';
import { dispatchMail, describeVisit } from './appointmentMailService.js';
import { Actor, replacementOf, retireOldRows } from './appointmentRescheduleSettle.js';
import { isNewRequest } from './appointmentStaffOrder.js';

const loadVisit = async (id, customerId = null) => {
  const rows = await findVisitRowsByAnyId(id, { customerId });
  if (rows.length === 0) throw fail(MSG.MSG38);
  return groupIntoVisits(rows)[0];
};

/** The shared core. Every access/time rule of the actor has been checked by the caller. */
const moveVisit = async ({ visit, scheduledAt, actor, userId, ipAddress, now }) => {
  const open = visit.rows.filter(isOpenRow);
  if (scheduledAt.getTime() === visit.scheduledAt.getTime()) throw violationToError({ kind: Violation.DUPLICATE_SLOT }, scheduledAt);

  const carIds = open.map((row) => String(row.car));
  const cars = await assertCarsSellable(carIds, { userId, ipAddress });

  const rule = { customerId: visit.customer, carIds, scheduledAt, now };
  const oldIds = open.map((row) => String(row._id));
  const before = await violationNow({ ...rule, mine: oldIds });
  if (before) throw violationToError(before, scheduledAt);

  const written = [];
  let after;
  try {
    for (const old of open) written.push(await insertWithCode(replacementOf(old, { actor, userId, now, scheduledAt })));
    after = await violationNow({ ...rule, mine: [...oldIds, ...written.map((row) => String(row._id))] });
  } catch (error) {
    await hideRows(written, userId, ABORTED_REASON);
    throw error;
  }
  if (after) {
    await hideRows(written, userId, RACE_LOST_REASON);
    throw violationToError(after, scheduledAt);
  }

  const newCode = visitCodeOf(written);
  await retireOldRows({ open, written, newCode, userId });

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
