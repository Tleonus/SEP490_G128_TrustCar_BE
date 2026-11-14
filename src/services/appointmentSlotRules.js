/**
 * @file appointmentSlotRules.js
 * @description Pure time rules of the test-drive booking: fixed slots in Vietnam
 * time (UTC+7), GBR-19 booking window, calendar-date helpers. No database access.
 *
 * Times are stored in UTC; slot matching converts with the fixed +7 offset
 * (Vietnam has no daylight saving time).
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-006, REQ-007, NFR-06)
 */

import { APPOINTMENT_CONSTRAINTS } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { SLOTS, VN_UTC_OFFSET_HOURS, SlotReason } from '../constants/appointmentRules.js';
import { fail } from './appointmentErrors.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const VN_OFFSET_MS = VN_UTC_OFFSET_HOURS * HOUR_MS;
const DATE_KEY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n) => String(n).padStart(2, '0');

/** Wall-clock parts of `date` in Vietnam time. */
export const toVnParts = (date) => {
  const shifted = new Date(date.getTime() + VN_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    ms: shifted.getUTCMilliseconds(),
  };
};

/** `YYYY-MM-DD` of `date` in Vietnam time. */
export const vnDateKey = (date) => {
  const p = toVnParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

/**
 * Parses a `YYYY-MM-DD` calendar date. Returns null when the format is wrong or
 * the date does not exist (e.g. 2026-02-30).
 */
export const parseDateKey = (dateKey) => {
  const match = DATE_KEY_REGEX.exec(String(dateKey));
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  const valid = probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
  return valid ? { year, month, day } : null;
};

/** The instant at which a Vietnam wall-clock time occurs (as a UTC Date). */
export const vnInstant = ({ year, month, day }, hour = 0, minute = 0) =>
  new Date(Date.UTC(year, month - 1, day, hour, minute) - VN_OFFSET_MS);

/** 00:00 (Vietnam) of the day containing `date`. */
export const startOfVnDay = (date) => vnInstant(toVnParts(date));

/** Vietnam-offset ISO string without milliseconds, e.g. `2026-11-10T08:00:00+07:00`. */
export const formatVnIso = (date) => {
  const p = toVnParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}+07:00`;
};

/** `HH:MM` slot label of `date` when it sits exactly on a slot, else null. */
export const slotLabelOf = (date) => {
  const p = toVnParts(date);
  if (p.second !== 0 || p.ms !== 0) return null;
  const label = `${pad(p.hour)}:${pad(p.minute)}`;
  return SLOTS.includes(label) ? label : null;
};

export const isOnSlot = (date) => slotLabelOf(date) !== null;

/** All slot start instants of one Vietnam calendar day (`YYYY-MM-DD`). */
export const slotStartsForDate = (dateKey) => {
  const parts = parseDateKey(dateKey);
  if (!parts) return [];
  return SLOTS.map((label) => {
    const [hour, minute] = label.split(':').map(Number);
    return vnInstant(parts, hour, minute);
  });
};

/**
 * Why `start` is outside the GBR-19 window relative to `now`, or null when inside.
 * Exactly 2 hours / exactly 60 days ahead are still allowed.
 */
export const windowReason = (start, now = new Date()) => {
  const ahead = start.getTime() - now.getTime();
  if (ahead < APPOINTMENT_CONSTRAINTS.MIN_HOURS_AHEAD * HOUR_MS) return SlotReason.TOO_SOON;
  if (ahead > APPOINTMENT_CONSTRAINTS.MAX_DAYS_AHEAD * DAY_MS) return SlotReason.TOO_FAR;
  return null;
};

/**
 * Staff window (1.1.0): the slot must still be ahead and within 60 days. Staff are exempt
 * from the 2-hour lead time (a reminder call at 9:45 may move a 10:00 visit to 13:00).
 * Returns `PAST` (already started), `TOO_FAR`, or null.
 */
export const staffWindowReason = (start, now = new Date()) => {
  const ahead = start.getTime() - now.getTime();
  if (ahead <= 0) return SlotReason.PAST;
  if (ahead > APPOINTMENT_CONSTRAINTS.MAX_DAYS_AHEAD * DAY_MS) return SlotReason.TOO_FAR;
  return null;
};

/**
 * Like `assertBookableTime` but with the staff window: a slot that already started reports
 * `MSG35` (too soon), a slot beyond 60 days `MSG36`, and a time off the slot grid `MSG79`.
 *
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-034
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-039
 */
export const assertStaffBookableTime = (scheduledAt, now = new Date()) => {
  const reason = staffWindowReason(scheduledAt, now);
  if (reason === SlotReason.PAST) throw fail(MSG.MSG35);
  if (reason === SlotReason.TOO_FAR) throw fail(MSG.MSG36);
  if (!isOnSlot(scheduledAt)) throw fail(MSG.MSG79);
};

/**
 * Throws when `scheduledAt` cannot be booked: window first (so "1 hour from now"
 * reports TOO_SOON), then slot alignment.
 *
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-006
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-007
 * @param {Date} scheduledAt
 * @param {Date} [now]
 */
export const assertBookableTime = (scheduledAt, now = new Date()) => {
  const reason = windowReason(scheduledAt, now);
  if (reason === SlotReason.TOO_SOON) throw fail(MSG.MSG35);
  if (reason === SlotReason.TOO_FAR) throw fail(MSG.MSG36);
  if (!isOnSlot(scheduledAt)) throw fail(MSG.MSG79);
};
