/**
 * @file appointmentSlotService.js
 * @description Free/busy view of the visit slots for the booking modal: for each
 * day and slot, whether the customer can book it with the chosen cars, and why not.
 * One read query covers the whole date range (NFR-03).
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-013, NFR-03)
 */

import { APPOINTMENT_CONSTRAINTS } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import {
  SlotReason, SLOT_QUERY_MAX_DAYS, MAX_CONCURRENT_VISITS_PER_SLOT,
} from '../constants/appointmentRules.js';
import { fail } from './appointmentErrors.js';
import { invalid } from './appointmentInput.js';
import {
  parseDateKey, vnInstant, startOfVnDay, vnDateKey, slotStartsForDate, windowReason, formatVnIso,
} from './appointmentSlotRules.js';
import { findOpenInRange, findVisitRowsByAnyId } from './appointmentQueries.js';

const DAY_MS = 24 * 3600 * 1000;

/** Validates `from`/`to` (YYYY-MM-DD, Vietnam days) and returns the instants of both days. */
export const parseRange = (from, to, now) => {
  const start = parseDateKey(from);
  const end = parseDateKey(to);
  if (!start) throw invalid('from', 'from must be a valid date (YYYY-MM-DD).');
  if (!end) throw invalid('to', 'to must be a valid date (YYYY-MM-DD).');
  const first = vnInstant(start);
  const last = vnInstant(end);
  const days = Math.round((last - first) / DAY_MS) + 1;
  if (days < 1) throw invalid('to', 'to must not be before from.');
  if (days > SLOT_QUERY_MAX_DAYS) throw invalid('to', `The range must not exceed ${SLOT_QUERY_MAX_DAYS} days.`);
  const today = startOfVnDay(now);
  if (first < today) throw invalid('from', 'from must not be in the past.');
  if (last - today > APPOINTMENT_CONSTRAINTS.MAX_DAYS_AHEAD * DAY_MS) {
    throw invalid('to', `to must be within ${APPOINTMENT_CONSTRAINTS.MAX_DAYS_AHEAD} days from today.`);
  }
  return { first, last, days };
};

const groupByTime = (rows) => {
  const byTime = new Map();
  rows.forEach((row) => {
    const key = new Date(row.scheduledAt).getTime();
    byTime.set(key, [...(byTime.get(key) ?? []), row]);
  });
  return byTime;
};

/** Describes one slot for this customer and these cars. */
const describeSlot = (start, rows, { customerId, wanted, now }) => {
  const base = { start: formatVnIso(start) };
  const timeReason = windowReason(start, now);
  if (timeReason) return { ...base, available: false, reason: timeReason };

  const me = String(customerId);
  if (rows.some((row) => String(row.customer) === me)) return { ...base, available: false, reason: SlotReason.ALREADY_BOOKED };

  const others = rows.filter((row) => String(row.customer) !== me);
  const busy = wanted.filter((carId) => others.some((row) => String(row.car) === carId));
  if (busy.length > 0) return { ...base, available: false, reason: SlotReason.CAR_BOOKED, carIds: busy };

  if (new Set(others.map((row) => String(row.customer))).size >= MAX_CONCURRENT_VISITS_PER_SLOT) {
    return { ...base, available: false, reason: SlotReason.CAPACITY_FULL };
  }
  return { ...base, available: true };
};

/**
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-013
 * @param {object} p
 * @param {string} p.customerId
 * @param {string[]} p.carIds  Cars the customer wants to visit (1..3).
 * @param {string} p.from      `YYYY-MM-DD` (Vietnam day).
 * @param {string} p.to        `YYYY-MM-DD`, inclusive.
 * @param {string} [p.excludeVisitId] One of THIS customer's own visits (any appointment id of
 *   it): its appointments are ignored, so the slots look as they would after that visit moved
 *   (REQ-036). Not the customer's visit → 404.
 * @param {Date} [p.now]
 * @returns {Promise<{ days: Array<{ date: string, slots: object[] }> }>}
 */
export const getSlots = async ({ customerId, carIds, from, to, excludeVisitId = null, now = new Date() }) => {
  if (!customerId) throw fail(MSG.MSG31);
  const { first, days } = parseRange(from, to, now);
  let rows = await findOpenInRange(first, new Date(first.getTime() + days * DAY_MS));
  if (excludeVisitId) {
    const own = await findVisitRowsByAnyId(excludeVisitId, { customerId });
    if (own.length === 0) throw fail(MSG.MSG38);
    const skip = new Set(own.map((row) => String(row._id)));
    rows = rows.filter((row) => !skip.has(String(row._id)));
  }
  const byTime = groupByTime(rows);
  const wanted = carIds.map(String);

  const result = [];
  for (let i = 0; i < days; i += 1) {
    const date = vnDateKey(new Date(first.getTime() + i * DAY_MS));
    const slots = slotStartsForDate(date).map((start) =>
      describeSlot(start, byTime.get(start.getTime()) ?? [], { customerId, wanted, now }));
    result.push({ date, slots });
  }
  return { days: result };
};

export default { getSlots };
