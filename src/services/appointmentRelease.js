/**
 * @file appointmentRelease.js
 * @description Closes ONE open row (single-car cancellation) and keeps the visit's holds right.
 *
 * Closing a row releases its holds in the same update (`$unset RELEASE_HOLDS`). When that row was
 * the one carrying the visit's seat and the visit still has other open rows (one car of a
 * several-car visit was cancelled), the seat moves to the remaining row with the lowest
 * appointment code, in the same transaction — a visit that is open always has exactly one seat.
 *
 * Whole-visit closings (customer cancel, staff status change, reschedule) release every open row
 * of the visit at once and need no transfer; they use `RELEASE_HOLDS` directly.
 *
 * Ref: .sdd/features/test-drive-capacity-guard/SPEC.md (REQ-214, REQ-215, AC-15, AC-16)
 */

import Appointment from '../models/Appointment.js';
import { OPEN_STATUSES } from '../constants/appointmentRules.js';
import { withTransaction } from '../utils/withTransaction.js';
import { RELEASE_HOLDS, leadRowOf } from './appointmentHolds.js';
import { runWithRetry } from './appointmentTransaction.js';

/**
 * Compare-and-set close of one row: only if it is still open. Returns the row as it was BEFORE the
 * update (truthy), or null when somebody else closed it first.
 *
 * @param {{ _id: * }} row
 * @param {object} set  Fields to `$set` (status, reason, updatedBy…).
 * @returns {Promise<object|null>}
 */
export const closeRowKeepingSeat = (row, set) => runWithRetry(() => withTransaction(async (session) => {
  const before = await Appointment.findOneAndUpdate(
    { _id: row._id, status: { $in: OPEN_STATUSES }, isActive: true },
    { $set: set, $unset: RELEASE_HOLDS },
    { new: false, session },
  ).lean();
  if (!before) return null;

  if (typeof before.visitSeat === 'number') {
    const remaining = await Appointment.find({
      customer: before.customer,
      scheduledAt: before.scheduledAt,
      status: { $in: OPEN_STATUSES },
      isActive: true,
      _id: { $ne: before._id },
    }).session(session).lean();
    const lead = leadRowOf(remaining);
    if (lead) await Appointment.updateOne({ _id: lead._id }, { $set: { visitSeat: before.visitSeat } }, { session });
  }
  return before;
}));

export default { closeRowKeepingSeat };
