/**
 * @file testDriveCancellation.js
 * @description Cancels a holding appointment. The conditional update means that when
 * the customer, staff and the scheduled job act at once, exactly one of them cancels:
 * the seat is given back once, and only that caller sends the email.
 *
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-032
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-034
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-041
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-045
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-047
 */

import Appointment from '../models/Appointment.js';
import { ActivityEventType, AppointmentStatus, AppointmentType, TEST_DRIVE_ACTIVE_STATUSES } from '../constants/appConstants.js';
import { withTransaction } from '../utils/withTransaction.js';
import { logAppointmentEvent } from './testDriveAudit.js';
import { sendCancellationEmail } from './testDriveMail.js';
import { retryOnWriteConflict } from './testDriveRetry.js';

/**
 * @param {object} params
 * @param {object} params.filter - Extra conditions, e.g. { _id, customer } or a time limit.
 * @param {string} params.reason - Text stored on the appointment; the customer sees it.
 * @param {{_id: *, email?: string}|null} params.actor - null for the scheduled job.
 * @param {boolean} [params.notify=true] - Whether to email the customer.
 * @returns {Promise<object|null>} the cancelled appointment, or null when nothing matched
 */
export const cancelAppointment = async ({ filter, reason, actor, notify = true }) => {
  const appointment = await retryOnWriteConflict(() => withTransaction(async (session) => {
    const cancelled = await Appointment.findOneAndUpdate(
      { ...filter, type: AppointmentType.TEST_DRIVE, status: { $in: TEST_DRIVE_ACTIVE_STATUSES } },
      {
        $set: { status: AppointmentStatus.CANCELLED, cancellationReason: reason, updatedBy: actor?._id ?? null },
        $unset: { slotSeat: 1 },
      },
      { new: true, session },
    ).lean();

    if (cancelled) {
      await logAppointmentEvent({
        eventType: ActivityEventType.APPOINTMENT_CANCELLED,
        appointment: cancelled,
        actor,
        session,
        summary: `Test drive cancelled: ${reason}`.slice(0, 500),
      });
    }
    return cancelled;
  }));

  if (appointment && notify) await sendCancellationEmail(appointment);
  return appointment;
};

export default { cancelAppointment };
