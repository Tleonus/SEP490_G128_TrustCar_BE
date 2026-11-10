/**
 * @file appointmentStaffOrder.js
 * @description Order of the staff visit list: visits that need the staff's attention are pinned to
 * the top, everything else follows the visit time (Spec REQ-042…044, C30).
 *
 * Pinned ("isNewRequest"):
 *   (a) every PENDING visit, whatever day it was sent or moved, until staff confirm or cancel it;
 *   (b) a CONFIRMED visit that staff moved or booked on behalf of the customer TODAY (it is
 *       confirmed in the same instant it is created, so no later step could release the pin; it
 *       stays pinned until the end of the Vietnam day).
 * The flag is computed on every call from data already loaded; nothing is stored.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-042, REQ-043, REQ-044, C30)
 */

import { AppointmentStatus } from '../constants/appConstants.js';
import { PIN_CONFIRMED_WITHIN_MS } from '../constants/appointmentRules.js';
import { startOfVnDay } from './appointmentSlotRules.js';
import { bookedAtOf, deriveVisitStatus } from './appointmentVisitRules.js';

const timeOf = (value) => new Date(value).getTime();

/**
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-044
 * @param {{ rows: object[] }} visit
 * @param {Date} [now]
 */
export const isNewRequest = (visit, now = new Date()) => {
  const status = deriveVisitStatus(visit.rows);
  if (status === AppointmentStatus.PENDING) return true;
  if (status !== AppointmentStatus.CONFIRMED) return false;

  const bookedAt = bookedAtOf(visit.rows);
  if (bookedAt < startOfVnDay(now)) return false;
  const confirmedAt = visit.rows.find((row) => row.confirmedAt)?.confirmedAt;
  return confirmedAt != null && Math.abs(timeOf(confirmedAt) - timeOf(bookedAt)) <= PIN_CONFIRMED_WITHIN_MS;
};

const byVisitId = (a, b) => (a.visitId < b.visitId ? -1 : a.visitId > b.visitId ? 1 : 0);

/**
 * Pinned visits first (newest booking first), then the rest by visit time (`asc` by default,
 * `desc` when asked). Ties fall back to the visit id so the order is stable between calls.
 *
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-042
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-043
 * @param {object[]} visits   Grouped visits (see `groupIntoVisits`).
 * @param {{ sort?: 'asc'|'desc', now?: Date }} [options]
 */
export const orderForStaff = (visits, { sort = 'asc', now = new Date() } = {}) => {
  const pinned = [];
  const rest = [];
  visits.forEach((visit) => (isNewRequest(visit, now) ? pinned : rest).push(visit));

  pinned.sort((a, b) => timeOf(bookedAtOf(b.rows)) - timeOf(bookedAtOf(a.rows)) || byVisitId(a, b));
  const direction = sort === 'desc' ? -1 : 1;
  rest.sort((a, b) => direction * (timeOf(a.scheduledAt) - timeOf(b.scheduledAt)) || byVisitId(a, b));
  return [...pinned, ...rest];
};
