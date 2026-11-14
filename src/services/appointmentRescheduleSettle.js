/**
 * @file appointmentRescheduleSettle.js
 * @description What the new appointment of a moved visit looks like (`replacementOf`) and who is
 * moving it (`Actor`). The move itself — hiding the old rows, writing the new ones, releasing and
 * taking the holds — is one transaction in `appointmentRescheduleService.js`.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-033, C18);
 *      .sdd/features/test-drive-capacity-guard/SPEC.md (REQ-216)
 */

import { AppointmentStatus } from '../constants/appConstants.js';

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

export default { Actor, replacementOf };
