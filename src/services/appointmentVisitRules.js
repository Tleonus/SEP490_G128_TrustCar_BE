/**
 * @file appointmentVisitRules.js
 * @description Pure rules about a "visit": appointments of one customer at one
 * `scheduledAt`. Grouping, derived status, cancellation type, "late cancel" flag
 * and the staff status-transition table (C5). No database access.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (Thuật ngữ, REQ-016, REQ-019, C4, C5, C7)
 */

import { AppointmentStatus } from '../constants/appConstants.js';
import {
  AUTO_CANCEL_PREFIX,
  CancellationType,
  LATE_CANCEL_HOURS,
  LATE_CANCEL_GRACE_MIN,
  MAX_RESCHEDULES_PER_VISIT,
  OPEN_STATUSES,
  SELF_RESCHEDULE_MIN_HOURS,
  STAFF_REMINDER_WINDOW_MIN,
} from '../constants/appointmentRules.js';
import { parseStaffReason } from './appointmentCancelReason.js';

const HOUR_MS = 3600 * 1000;
const MINUTE_MS = 60 * 1000;
const idOf = (value) => String(value);
const timeOf = (value) => new Date(value).getTime();

const byId = (a, b) => (idOf(a._id) < idOf(b._id) ? -1 : 1);
const byCode = (a, b) => String(a.appointmentCode).localeCompare(String(b.appointmentCode), 'en', { numeric: true });

/** Status priority used to derive the status of a whole visit. */
const STATUS_PRIORITY = [
  AppointmentStatus.PENDING,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.COMPLETED,
  AppointmentStatus.NO_SHOW,
  AppointmentStatus.CANCELLED,
];

/**
 * Groups active rows into visits (key: customer + scheduledAt). `visitId` is the
 * smallest row `_id`. Visits keep the order in which they first appear in `rows`.
 *
 * @param {object[]} rows
 * @returns {Array<{ visitId: string, customer: *, scheduledAt: Date, rows: object[] }>}
 */
export const groupIntoVisits = (rows) => {
  const groups = new Map();
  rows.filter((row) => row.isActive !== false).forEach((row) => {
    const key = `${idOf(row.customer)}|${timeOf(row.scheduledAt)}`;
    if (!groups.has(key)) groups.set(key, { customer: row.customer, scheduledAt: new Date(row.scheduledAt), rows: [] });
    groups.get(key).rows.push(row);
  });
  return [...groups.values()].map((visit) => {
    const sorted = [...visit.rows].sort(byId);
    return { ...visit, rows: sorted, visitId: idOf(sorted[0]._id) };
  });
};

/** Derived status of a visit (Spec "Trạng thái lượt"). */
export const deriveVisitStatus = (rows) =>
  STATUS_PRIORITY.find((status) => rows.some((row) => row.status === status)) ?? AppointmentStatus.CANCELLED;

/** `visitCode` = smallest appointment code of the visit. */
export const visitCodeOf = (rows) => [...rows].sort(byCode)[0]?.appointmentCode ?? null;

export const isOpenRow = (row) => OPEN_STATUSES.includes(row.status) && row.isActive !== false;

const isAutoCancelled = (row) => String(row.cancellationReason ?? '').startsWith(AUTO_CANCEL_PREFIX);

/**
 * Who cancelled a fully cancelled visit, and the reason to show (Spec C21).
 * - Every cancelled row auto-cancelled → CAR_UNAVAILABLE (reason hidden; the client translates).
 * - Otherwise the first human-cancelled row decides, by its reason alone: a staff value
 *   `<CODE>|<note>` → STAFF (reason = the code's label, note kept apart); anything else → CUSTOMER.
 *   Who created the visit does not matter (a visit booked by staff can be cancelled by the customer).
 *
 * @returns {{ type: string, reason: string|null, note: string|null, cancelledAt: Date|null }|null}
 *   null unless CANCELLED.
 */
export const cancellationOf = (rows) => {
  if (deriveVisitStatus(rows) !== AppointmentStatus.CANCELLED) return null;
  const human = rows.find((row) => !isAutoCancelled(row));
  if (!human) return { type: CancellationType.CAR_UNAVAILABLE, reason: null, note: null, cancelledAt: rows[0]?.updatedAt ?? null };
  const staff = parseStaffReason(human.cancellationReason);
  return {
    type: staff ? CancellationType.STAFF : CancellationType.CUSTOMER,
    reason: staff ? staff.label : (human.cancellationReason ?? null),
    note: staff?.note ?? null,
    cancelledAt: human.updatedAt ?? null,
  };
};

/**
 * "Late" cancellation (C4): the customer cancelled less than LATE_CANCEL_HOURS before
 * the visit AND more than LATE_CANCEL_GRACE_MIN after booking it.
 *
 * @param {Date} scheduledAt
 * @param {Date} bookedAt     Earliest `createdAt` of the visit.
 * @param {Date} cancelledAt
 */
export const isLateCancellation = (scheduledAt, bookedAt, cancelledAt) => {
  const untilVisit = timeOf(scheduledAt) - timeOf(cancelledAt);
  const sinceBooking = timeOf(cancelledAt) - timeOf(bookedAt);
  return untilVisit < LATE_CANCEL_HOURS * HOUR_MS && sinceBooking > LATE_CANCEL_GRACE_MIN * MINUTE_MS;
};

/** Earliest `createdAt` of the visit's rows. */
export const bookedAtOf = (rows) => new Date(Math.min(...rows.map((row) => timeOf(row.createdAt))));

/**
 * Why a CUSTOMER may not reschedule online (Spec REQ-032), or null when they may.
 *  - NOT_ALLOWED: no open appointment left, the visit started, or less than 12 hours remain.
 *  - LIMIT: already rescheduled `MAX_RESCHEDULES_PER_VISIT` times.
 * NOT_ALLOWED outranks LIMIT. Exactly 12 hours before is still allowed.
 *
 * @param {{ scheduledAt: Date, rows: object[] }} visit
 * @param {number} count  Earlier reschedules of this visit (see `countReschedules`).
 * @returns {'NOT_ALLOWED'|'LIMIT'|null}
 */
export const rescheduleBlock = (visit, count, now = new Date()) => {
  const remaining = timeOf(visit.scheduledAt) - timeOf(now);
  if (!visit.rows.some(isOpenRow) || remaining < SELF_RESCHEDULE_MIN_HOURS * HOUR_MS) return 'NOT_ALLOWED';
  return count >= MAX_RESCHEDULES_PER_VISIT ? 'LIMIT' : null;
};

export const canSelfReschedule = (visit, count, now = new Date()) => rescheduleBlock(visit, count, now) === null;

/** The two reschedule fields every customer visit carries (Spec section 5, 1.1.0). */
export const customerExtras = (visit, count, now = new Date()) => ({
  rescheduleCount: count,
  canReschedule: canSelfReschedule(visit, count, now),
});

// ── Staff reminders (C26) ─────────────────────────────────────────────────────

const MIN_MS = 60 * 1000;

/**
 * "Phone the customer now": a CONFIRMED visit whose start is at most
 * `STAFF_REMINDER_WINDOW_MIN` minutes away and has not passed yet. Purely informational —
 * the system never changes a status because of it.
 */
export const needsReminderCall = (visit, now = new Date()) => {
  const untilStart = timeOf(visit.scheduledAt) - timeOf(now);
  return deriveVisitStatus(visit.rows) === AppointmentStatus.CONFIRMED
    && untilStart >= 0 && untilStart <= STAFF_REMINDER_WINDOW_MIN * MIN_MS;
};

/**
 * "This visit should have been closed": it still has an open appointment although its time
 * (start + duration) is over. Staff must record COMPLETED or NO_SHOW; the system never does.
 */
export const needsOutcome = (visit, now = new Date()) => {
  const minutes = visit.rows[0]?.durationMinutes ?? 0;
  return visit.rows.some(isOpenRow) && timeOf(now) > timeOf(visit.scheduledAt) + minutes * MIN_MS;
};

// ── Staff transitions (C5) ────────────────────────────────────────────────────

const { PENDING, CONFIRMED, COMPLETED, NO_SHOW, CANCELLED } = AppointmentStatus;

export const STAFF_TRANSITIONS = Object.freeze({
  [PENDING]: [CONFIRMED, CANCELLED],
  [CONFIRMED]: [COMPLETED, NO_SHOW, CANCELLED],
  [COMPLETED]: [],
  [NO_SHOW]: [],
  [CANCELLED]: [],
});

/**
 * Whether staff may move a visit from `current` to `target` at `now`.
 * COMPLETED / NO_SHOW need the visit time to have arrived.
 */
export const canTransition = (current, target, scheduledAt, now = new Date()) => {
  if (!(STAFF_TRANSITIONS[current] ?? []).includes(target)) return false;
  if ((target === COMPLETED || target === NO_SHOW) && timeOf(now) < timeOf(scheduledAt)) return false;
  return true;
};
