/**
 * @file appointmentStaffService.js
 * @description Staff (ADMIN / SALES_STAFF) handling of visits: list with filters, read,
 * and change status for the whole visit (confirm, cancel, complete, no-show).
 * Transitions follow C5; a status change applies to every OPEN appointment of the visit.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-018…021, 023, C5)
 */

import Appointment from '../models/Appointment.js';
import { AppointmentStatus } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { OPEN_STATUSES, NEEDS_OUTCOME_LOOKBACK_DAYS } from '../constants/appointmentRules.js';
import { fail } from './appointmentErrors.js';
import { invalid, normalizeOutcome, normalizeStaffCancel, paginateVisits } from './appointmentInput.js';
import { parseDateKey, startOfVnDay, vnInstant } from './appointmentSlotRules.js';
import {
  findRowsInRange, findVisitRowsByAnyId, loadVisitContext,
} from './appointmentQueries.js';
import {
  canTransition, cancellationOf, deriveVisitStatus, groupIntoVisits, isOpenRow, needsReminderCall, needsOutcome,
} from './appointmentVisitRules.js';
import { countReschedules } from './appointmentRescheduleChain.js';
import { toStaffVisit } from './appointmentVisitMapper.js';
import { logStatusChanges } from './appointmentAudit.js';
import { parseStaffReason } from './appointmentCancelReason.js';
import { assertCarsSellable, reconcileOpenAppointments } from './appointmentReconcileService.js';
import { isNewRequest, orderForStaff } from './appointmentStaffOrder.js';
import { MailEvent } from './appointmentMailTemplates.js';
import { dispatchMail, describeVisit } from './appointmentMailService.js';

const DAY_MS = 24 * 3600 * 1000;

/**
 * Staff DTOs for a page of visits, with the reschedule count (3 reads for the whole page, not
 * per visit) and the two reminder flags. `context` may be passed when already loaded.
 */
const present = async (visits, now, context = null) => {
  const [loaded, counts] = await Promise.all([
    context ?? loadVisitContext(visits, { staff: true }),
    countReschedules(visits),
  ]);
  return visits.map((visit) => toStaffVisit(visit, loaded.carsById, loaded.customersById, loaded.usersById, {
    rescheduleCount: counts.get(visit.visitId),
    needsReminderCall: needsReminderCall(visit, now),
    needsOutcome: needsOutcome(visit, now),
    isNewRequest: isNewRequest(visit, now),
  }));
};

/**
 * `from` defaults to 00:00 today (Vietnam), or 7 days earlier when looking for visits that
 * still need an outcome (they are in the past by definition); `to` is an inclusive day.
 */
const boundsOf = ({ from, to, needsOutcome: wantsOutcome }, now) => {
  const fromKey = from ? parseDateKey(from) : null;
  const toKey = to ? parseDateKey(to) : null;
  if (from && !fromKey) throw invalid('from', 'from must be a valid date (YYYY-MM-DD).');
  if (to && !toKey) throw invalid('to', 'to must be a valid date (YYYY-MM-DD).');
  const lookBack = isTrue(wantsOutcome) ? NEEDS_OUTCOME_LOOKBACK_DAYS * DAY_MS : 0;
  const start = fromKey ? vnInstant(fromKey) : new Date(startOfVnDay(now).getTime() - lookBack);
  const end = toKey ? new Date(vnInstant(toKey).getTime() + DAY_MS) : null;
  if (end && end <= start) throw invalid('to', 'to must not be before from.');
  return { start, end };
};

/** Query booleans arrive as `true` (validated) or the string 'true'. */
const isTrue = (value) => value === true || value === 'true';

const matchesFilters = (visit, query, now) => {
  const { status, carId, cancellationType } = query;
  if (status && deriveVisitStatus(visit.rows) !== status) return false;
  if (carId && !visit.rows.some((row) => String(row.car) === String(carId))) return false;
  if (cancellationType && cancellationOf(visit.rows)?.type !== cancellationType) return false;
  if (isTrue(query.needsReminderCall) && !needsReminderCall(visit, now)) return false;
  if (isTrue(query.needsOutcome) && !needsOutcome(visit, now)) return false;
  return true;
};

/**
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-018
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-027
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-037
 * @param {object} p
 * @param {object} [p.query] `{ status?, carId?, from?, to?, cancellationType?, needsReminderCall?, needsOutcome?, page?, limit? }`
 * @param {string|null} [p.userId]  Staff user (recorded when reconciliation cancels something).
 */
export const listVisits = async ({ query = {}, userId = null, ipAddress, now = new Date() }) => {
  const { start, end } = boundsOf(query, now);
  await reconcileOpenAppointments({ userId, ipAddress, now }); // never throws
  const matching = groupIntoVisits(await findRowsInRange(start, end)).filter((visit) => matchesFilters(visit, query, now));
  const visits = orderForStaff(matching, { sort: query.sort, now });
  const { items, pagination } = paginateVisits(visits, query);
  return { visits: await present(items, now), pagination };
};

const loadVisit = async (id) => {
  const rows = await findVisitRowsByAnyId(id);
  if (rows.length === 0) throw fail(MSG.MSG38);
  return groupIntoVisits(rows)[0];
};

/** @ears .sdd/features/test-drive-booking/SPEC.md#REQ-018 */
export const getVisit = async ({ id, now = new Date() }) => {
  const [visit] = await present([await loadVisit(id)], now);
  return visit;
};

const fieldsFor = (status, { userId, now, note, outcome }) => {
  const base = { status, updatedBy: userId };
  switch (status) {
    case AppointmentStatus.CONFIRMED: return { ...base, confirmedBy: userId, confirmedAt: now };
    case AppointmentStatus.CANCELLED: return { ...base, cancellationReason: note };
    case AppointmentStatus.COMPLETED: return { ...base, completedAt: now, outcome };
    default: return { ...base, outcome }; // NO_SHOW
  }
};

/** E-mail to the customer for the two staff actions that concern them (REQ-028 b, d). */
const notifyStatusChange = ({ status, visit, open, note, carsById }) => {
  const event = { [AppointmentStatus.CONFIRMED]: MailEvent.CONFIRMED, [AppointmentStatus.CANCELLED]: MailEvent.CANCELLED_BY_STAFF }[status];
  if (!event) return; // COMPLETED / NO_SHOW: no e-mail
  const data = describeVisit(open, carsById, visit.rows);
  // Only the label of the chosen reason is ever sent; the internal note stays out (C20).
  if (event === MailEvent.CANCELLED_BY_STAFF) data.reasonLabel = parseStaffReason(note)?.label ?? null;
  dispatchMail({ event, customerId: visit.customer, data });
};

/**
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-019
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-020
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-021
 * @param {object} p
 * @param {string} p.id        Any appointment id of the visit.
 * @param {string} p.userId    Staff user.
 * @param {string} p.status    CONFIRMED | CANCELLED | COMPLETED | NO_SHOW
 * @param {string} [p.reasonCode] CANCELLED only: one of the staff cancel reasons (default OTHER).
 * @param {string} [p.reason]  CANCELLED only: internal note (required when the code is OTHER).
 * @param {string} [p.outcome] Optional note for COMPLETED / NO_SHOW.
 */
export const changeVisitStatus = async ({
  id, userId, status, reason, reasonCode, outcome, ipAddress, now = new Date(),
}) => {
  if (reasonCode && status !== AppointmentStatus.CANCELLED) throw invalid('reasonCode', 'reasonCode is only allowed when cancelling.');
  const note = status === AppointmentStatus.CANCELLED ? normalizeStaffCancel({ reasonCode, reason }) : null;
  const result = normalizeOutcome(outcome);

  const visit = await loadVisit(id);
  if (!canTransition(deriveVisitStatus(visit.rows), status, visit.scheduledAt, now)) throw fail(MSG.MSG81);

  const open = visit.rows.filter(isOpenRow);
  if (status === AppointmentStatus.CONFIRMED) await assertCarsSellable(open.map((row) => row.car), { userId, ipAddress });

  const update = await Appointment.updateMany(
    { _id: { $in: open.map((row) => row._id) }, status: { $in: OPEN_STATUSES }, isActive: true },
    { $set: fieldsFor(status, { userId, now, note, outcome: result }) },
  );
  if (update.modifiedCount === 0) throw fail(MSG.MSG81); // changed by somebody else meanwhile

  if (status === AppointmentStatus.CONFIRMED) {
    await Appointment.updateMany({ _id: { $in: open.map((row) => row._id) }, assignedTo: null }, { $set: { assignedTo: userId } });
  }
  await logStatusChanges(open.map((row) => ({ appointment: row, from: row.status })), {
    status, userId, ipAddress, metadata: note ? { reason: note } : null,
  });

  const fresh = await loadVisit(id);
  const context = await loadVisitContext([fresh], { staff: true });
  notifyStatusChange({ status, visit: fresh, open, note, carsById: context.carsById });
  const [dto] = await present([fresh], now, context);
  return dto;
};

export default { listVisits, getVisit, changeVisitStatus };
