/**
 * @file appointmentStaffSlotService.js
 * @description The slot grid as STAFF need it (REQ-035): for every slot, how many places are
 * left and WHO is booked there (customer name and phone, cars), so that on the phone they can
 * answer "is Friday 13:00 free?" and move a customer without trial and error.
 *
 * Differences from the customer grid: shows who booked (the customer grid never does), has no
 * 2-hour lead time (a slot only turns `PAST` once it has started), and has no per-customer
 * reasons (`ALREADY_BOOKED`) — booking/moving reports those itself.
 *
 * Reads: one for the appointments of the whole range, then at most one each for customers and
 * cars (NFR-09); two more when `excludeVisitId` is given.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-035, NFR-09)
 */

import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { SlotReason, MAX_CONCURRENT_VISITS_PER_SLOT } from '../constants/appointmentRules.js';
import { fail } from './appointmentErrors.js';
import { parseRange } from './appointmentSlotService.js';
import { vnDateKey, slotStartsForDate, staffWindowReason, formatVnIso } from './appointmentSlotRules.js';
import { findOpenInRangeWithCode, findVisitRowsByAnyId, loadVisitContext } from './appointmentQueries.js';
import { groupIntoVisits, deriveVisitStatus, visitCodeOf } from './appointmentVisitRules.js';

const DAY_MS = 24 * 3600 * 1000;
const idOf = (value) => String(value);

const carBrief = (car, carId) => ({
  _id: carId,
  vehicleCode: car?.vehicleCode ?? null,
  make: car?.make ?? null,
  model: car?.model ?? null,
});

const visitBrief = (visit, { carsById, customersById }) => {
  const customer = customersById.get(idOf(visit.customer));
  return {
    visitId: visit.visitId,
    visitCode: visitCodeOf(visit.rows),
    status: deriveVisitStatus(visit.rows),
    customer: {
      _id: idOf(visit.customer),
      fullName: customer?.fullName ?? null,
      phone: customer?.phone ?? null,
    },
    cars: visit.rows.map((row) => carBrief(carsById.get(idOf(row.car)), idOf(row.car))),
  };
};

/** Why `start` cannot take the wanted cars, or null when it can. */
const reasonFor = (start, { visits, wanted, now }) => {
  const timeReason = staffWindowReason(start, now);
  if (timeReason) return { reason: timeReason };
  const held = new Set(visits.flatMap((visit) => visit.rows.map((row) => idOf(row.car))));
  const busy = wanted.filter((carId) => held.has(carId));
  if (busy.length > 0) return { reason: SlotReason.CAR_BOOKED, carIds: busy };
  if (visits.length >= MAX_CONCURRENT_VISITS_PER_SLOT) return { reason: SlotReason.CAPACITY_FULL };
  return { reason: null };
};

/**
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-035
 * @param {object} p
 * @param {string} p.from  `YYYY-MM-DD` (Vietnam day).
 * @param {string} p.to    `YYYY-MM-DD`, inclusive (at most 14 days, within 60 days).
 * @param {string[]} [p.carIds]  Cars to check for conflicts; none → only capacity is judged.
 * @param {string} [p.excludeVisitId] A visit (any appointment id of it) to ignore, e.g. the one being moved.
 * @returns {Promise<{ days: Array<{ date: string, slots: object[] }> }>}
 */
export const getStaffSlots = async ({ from, to, carIds = [], excludeVisitId = null, now = new Date() }) => {
  const { first, days } = parseRange(from, to, now);
  let rows = await findOpenInRangeWithCode(first, new Date(first.getTime() + days * DAY_MS));
  if (excludeVisitId) {
    const own = await findVisitRowsByAnyId(excludeVisitId);
    if (own.length === 0) throw fail(MSG.MSG38);
    const skip = new Set(own.map((row) => idOf(row._id)));
    rows = rows.filter((row) => !skip.has(idOf(row._id)));
  }

  const visits = groupIntoVisits(rows);
  const context = await loadVisitContext(visits, { staff: true });
  const bySlot = new Map();
  visits.forEach((visit) => {
    const key = visit.scheduledAt.getTime();
    bySlot.set(key, [...(bySlot.get(key) ?? []), visit]);
  });
  const wanted = carIds.map(idOf);

  const result = [];
  for (let i = 0; i < days; i += 1) {
    const date = vnDateKey(new Date(first.getTime() + i * DAY_MS));
    const slots = slotStartsForDate(date).map((start) => {
      const there = bySlot.get(start.getTime()) ?? [];
      const { reason, carIds: busy } = reasonFor(start, { visits: there, wanted, now });
      return {
        start: formatVnIso(start),
        available: reason === null,
        capacityRemaining: Math.max(0, MAX_CONCURRENT_VISITS_PER_SLOT - there.length),
        reason,
        ...(busy ? { carIds: busy } : {}),
        visits: there.map((visit) => visitBrief(visit, context)),
      };
    });
    result.push({ date, slots });
  }
  return { days: result };
};

export default { getStaffSlots };
