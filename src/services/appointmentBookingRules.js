/**
 * @file appointmentBookingRules.js
 * @description The single pure function that decides whether a booking may exist.
 *
 * `createVisit` calls it twice with the same rule set:
 *   1. before writing, with `mine = []`;
 *   2. after writing, with `mine = ids just written` (re-check).
 * Any open row that is NOT mine and causes a violation makes me lose. Hence two
 * concurrent requests can never both win (they may both lose).
 *
 * Priority of violations: DUPLICATE_SLOT, DUPLICATE_CARS, LIMIT, CONFLICT, CAPACITY.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-008…012, INV-2/3/4)
 */

import { SystemMessages as MSG } from '../constants/systemMessages.js';
import {
  OPEN_STATUSES,
  MAX_OPEN_VISITS_PER_CUSTOMER,
  MAX_CONCURRENT_VISITS_PER_SLOT,
} from '../constants/appointmentRules.js';
import { fail } from './appointmentErrors.js';
import { formatVnIso } from './appointmentSlotRules.js';

export const Violation = Object.freeze({
  DUPLICATE_SLOT: 'DUPLICATE_SLOT',
  DUPLICATE_CARS: 'DUPLICATE_CARS',
  LIMIT: 'LIMIT',
  CONFLICT: 'CONFLICT',
  CAPACITY: 'CAPACITY',
});

const idOf = (value) => String(value);
const timeOf = (row) => new Date(row.scheduledAt).getTime();
const isOpenRow = (row) => OPEN_STATUSES.includes(row.status) && row.isActive !== false;

/**
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-008
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-009
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-010
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-011
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-012
 * @param {object}   p
 * @param {object[]} p.slotRows     Open rows of ANY customer at `scheduledAt` (fields: _id, customer, car).
 * @param {object[]} p.customerRows Open rows of THIS customer, any slot (fields: _id, car, scheduledAt).
 * @param {string}   p.customerId
 * @param {string[]} p.carIds
 * @param {Date}     p.scheduledAt
 * @param {string[]} [p.mine]       Row ids written by this very request (excluded from the check).
 * @param {Date}     [p.now]
 * @returns {null | { kind: string, carIds?: string[] }}
 */
export const evaluateBooking = ({
  slotRows, customerRows, customerId, carIds, scheduledAt, mine = [], now = new Date(),
}) => {
  const mineIds = new Set(mine.map(idOf));
  const notMine = (row) => isOpenRow(row) && !mineIds.has(idOf(row._id));
  const me = idOf(customerId);
  const slotTime = scheduledAt.getTime();

  const myOther = customerRows.filter(notMine).filter((row) => timeOf(row) > now.getTime());
  if (myOther.some((row) => timeOf(row) === slotTime)) return { kind: Violation.DUPLICATE_SLOT };

  const heldByMe = new Set(myOther.map((row) => idOf(row.car)));
  const dupCars = carIds.filter((carId) => heldByMe.has(idOf(carId)));
  if (dupCars.length > 0) return { kind: Violation.DUPLICATE_CARS, carIds: dupCars };

  const otherSlots = new Set(myOther.map(timeOf));
  if (otherSlots.size >= MAX_OPEN_VISITS_PER_CUSTOMER) return { kind: Violation.LIMIT };

  const others = slotRows.filter(notMine).filter((row) => timeOf(row) === slotTime && idOf(row.customer) !== me);
  const busy = new Set(others.map((row) => idOf(row.car)));
  const conflicts = carIds.filter((carId) => busy.has(idOf(carId)));
  if (conflicts.length > 0) return { kind: Violation.CONFLICT, carIds: conflicts };

  const guests = new Set(others.map((row) => idOf(row.customer)));
  if (guests.size >= MAX_CONCURRENT_VISITS_PER_SLOT) return { kind: Violation.CAPACITY };

  return null;
};

/** Maps a violation to the API error (Spec section 6). */
export const violationToError = (violation, scheduledAt) => {
  switch (violation.kind) {
    case Violation.DUPLICATE_SLOT: return fail(MSG.MSG82, { slot: formatVnIso(scheduledAt) });
    case Violation.DUPLICATE_CARS: return fail(MSG.MSG82, { carIds: violation.carIds });
    case Violation.LIMIT: return fail(MSG.MSG80);
    case Violation.CONFLICT: return fail(MSG.MSG37, { carIds: violation.carIds });
    case Violation.CAPACITY: return fail(MSG.MSG83);
    default: return fail(MSG.MSG62);
  }
};
