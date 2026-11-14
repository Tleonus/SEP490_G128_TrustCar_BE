/**
 * @file appointmentHolds.js
 * @description The "hold" bookkeeping of open test-drive rows (pure part).
 *
 *   holdsCar   true on EVERY open row            → unique index (car, scheduledAt)
 *   visitSeat  on ONE row of each open visit     → unique index (scheduledAt, seat)
 *              (the lead row = lowest appointmentCode)
 *
 * A row that is no longer open carries neither (they are `$unset` in the very update that closes
 * the row, see `RELEASE_HOLDS`). Old KAN-28 rows hold their place with `slotSeat`; it is read as
 * the seat and released the same way.
 *
 * Ref: .sdd/features/test-drive-capacity-guard/SPEC.md (REQ-212, REQ-214, REQ-215), PLAN.md 3.3–3.4
 */

import { OPEN_STATUSES } from '../constants/appointmentRules.js';

/** `$unset` payload for every update that takes a row out of the open states. */
export const RELEASE_HOLDS = Object.freeze({ holdsCar: 1, visitSeat: 1, slotSeat: 1 });

const isOpen = (row) => OPEN_STATUSES.includes(row.status) && row.isActive !== false;

/** The seat a row occupies in its slot: `visitSeat`, or `slotSeat` for an old KAN-28 row. */
export const seatOf = (row) => row.visitSeat ?? row.slotSeat ?? null;

/**
 * Smallest seat in `1…capacity` not held by any open row of the slot, or `null` when all are taken.
 * With fewer open visits than `capacity` a free seat always exists (pigeonhole); a visit that
 * kept a seat above a lowered capacity is still counted as holding it.
 *
 * @param {object[]} slotRows  Rows at the slot (non-open rows are ignored).
 * @param {number} capacity
 * @returns {number|null}
 */
export const pickVisitSeat = (slotRows, capacity) => {
  const used = new Set(slotRows.filter(isOpen).map(seatOf).filter((seat) => seat !== null));
  for (let seat = 1; seat <= capacity; seat += 1) {
    if (!used.has(seat)) return seat;
  }
  return null;
};

/** The numeric part of `APT-0001` / `APT-00010000`, so 4- and 8-digit codes order correctly. */
const codeNumber = (row) => Number.parseInt(String(row.appointmentCode ?? '').split('-')[1], 10);

/** The row of a visit that carries the seat: the one with the lowest appointment code. */
export const leadRowOf = (rows) =>
  rows.reduce((lead, row) => (lead === null || codeNumber(row) < codeNumber(lead) ? row : lead), null);

/**
 * Fields to store on a new open row.
 *
 * @param {{ lead: boolean, seat: number|null }} p
 * @returns {{ holdsCar: true, visitSeat?: number }}
 */
export const holdFields = ({ lead, seat }) => (lead ? { holdsCar: true, visitSeat: seat } : { holdsCar: true });

export default { RELEASE_HOLDS, seatOf, pickVisitSeat, leadRowOf, holdFields };
