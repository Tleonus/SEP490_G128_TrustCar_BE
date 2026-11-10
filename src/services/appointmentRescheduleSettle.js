/**
 * @file appointmentRescheduleSettle.js
 * @description The two risky steps of rescheduling, kept apart from the flow so they can be
 * read (and tested) on their own:
 *
 *   - `replacementOf`  what the new appointment of one old open appointment looks like;
 *   - `retireOldRows`  hide the old open rows with a compare-and-set, all or nothing; when it
 *                      cannot do exactly that, `undoMove` puts everything back.
 *
 * Why "all or nothing" with an undo (Spec REQ-033, INV-10, INV-11): the old visit must stay
 * untouched until the new one is proven, and two requests moving or cancelling the same visit
 * must end in exactly one outcome. The compare-and-set on "still open" is what lets the second
 * one notice it lost.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-033, C18, INV-10, INV-11)
 */

import Appointment from '../models/Appointment.js';
import { AppointmentStatus } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { OPEN_STATUSES, RESCHEDULED_PREFIX, ABORTED_REASON } from '../constants/appointmentRules.js';
import { fail } from './appointmentErrors.js';
import { hideRows } from './appointmentWrite.js';

export const Actor = Object.freeze({ CUSTOMER: 'CUSTOMER', STAFF: 'STAFF' });

/**
 * The replacement of one open row. A customer's move needs a fresh confirmation call (the
 * old one was for the old time) → PENDING. Staff just spoke to the customer → keep the status
 * (CONFIRMED stays CONFIRMED, confirmed by the staff member who moved it) (C18).
 */
export const replacementOf = (old, { actor, userId, now, scheduledAt }) => {
  const staff = actor === Actor.STAFF;
  const status = staff ? old.status : AppointmentStatus.PENDING;
  const confirmed = status === AppointmentStatus.CONFIRMED;
  return {
    customer: old.customer,
    car: old.car,
    type: old.type,
    scheduledAt,
    durationMinutes: old.durationMinutes,
    location: old.location,
    notes: old.notes,
    createdBy: old.createdBy,
    status,
    assignedTo: staff ? (old.assignedTo ?? (confirmed ? userId : null)) : null,
    confirmedBy: confirmed ? userId : null,
    confirmedAt: confirmed ? now : null,
  };
};

/**
 * Undo after the old rows could not be retired cleanly: hide the new rows and put back any old
 * row this request had already hidden (matched by the reason it wrote, so another request's
 * change is never overwritten).
 */
export const undoMove = async ({ written, open, reason, userId }) => {
  await hideRows(written, userId, ABORTED_REASON);
  for (const old of open) {
    try {
      await Appointment.updateMany(
        { _id: old._id, isActive: false, cancellationReason: reason },
        { $set: { status: old.status, isActive: true, cancellationReason: old.cancellationReason ?? null, updatedBy: old.updatedBy ?? null } },
      );
    } catch (error) {
      console.error('Reschedule undo failed for an appointment:', error.message);
    }
  }
};

/** Hides the old open rows (compare-and-set). All or nothing: anything else undoes the move. */
export const retireOldRows = async ({ open, written, newCode, userId }) => {
  const reason = `${RESCHEDULED_PREFIX}${newCode}`;
  let result;
  try {
    result = await Appointment.updateMany(
      { _id: { $in: open.map((row) => row._id) }, status: { $in: OPEN_STATUSES }, isActive: true },
      { $set: { status: AppointmentStatus.CANCELLED, isActive: false, cancellationReason: reason, updatedBy: userId } },
    );
  } catch (error) {
    await undoMove({ written, open, reason, userId });
    throw error;
  }
  if (result.modifiedCount === open.length) return;
  await undoMove({ written, open, reason, userId }); // somebody changed the visit meanwhile
  throw fail(MSG.MSG78);
};

export default { Actor, replacementOf, undoMove, retireOldRows };
