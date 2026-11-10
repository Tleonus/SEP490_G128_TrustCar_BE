/**
 * @file appointmentAudit.js
 * @description GBR-24 audit entries for appointments: maps a status to the right
 * `ActivityEventType` and writes through `ActivityLog.log` (which never throws
 * in development, and surfaces failures in production).
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-023)
 */

import ActivityLog from '../models/ActivityLog.js';
import { ActivityEventType, AppointmentStatus } from '../constants/appConstants.js';

const EVENT_BY_STATUS = Object.freeze({
  [AppointmentStatus.PENDING]: ActivityEventType.APPOINTMENT_CREATED,
  [AppointmentStatus.CONFIRMED]: ActivityEventType.APPOINTMENT_CONFIRMED,
  [AppointmentStatus.CANCELLED]: ActivityEventType.APPOINTMENT_CANCELLED,
  [AppointmentStatus.COMPLETED]: ActivityEventType.APPOINTMENT_COMPLETED,
  [AppointmentStatus.NO_SHOW]: ActivityEventType.APPOINTMENT_NO_SHOW,
});

/**
 * Logs one appointment event. `status` is the status the appointment now has
 * (`PENDING` means "created").
 *
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-023
 * @param {object} p
 * @param {object} p.appointment  Row with `_id` and `appointmentCode`.
 * @param {string} p.status       New status.
 * @param {string|null} p.userId  Actor (customer user or staff user).
 * @param {string} [p.from]       Previous status, when it changed.
 * @param {string} [p.summary]
 * @param {object} [p.metadata]
 * @param {string} [p.ipAddress]
 */
export const logAppointmentEvent = ({ appointment, status, userId, from, summary, metadata = null, ipAddress = null }) =>
  ActivityLog.log({
    eventType: EVENT_BY_STATUS[status],
    performedBy: userId ?? null,
    targetModel: 'Appointment',
    targetId: appointment._id,
    targetCode: appointment.appointmentCode,
    changes: from ? { before: { status: from }, after: { status } } : undefined,
    summary: summary ?? (from ? `Appointment ${from} → ${status}` : `Appointment ${status}`),
    metadata,
    ipAddress,
  });

/** Logs the same kind of event for several rows (sequentially: keeps log order stable). */
export const logAppointmentEvents = async (rows, params) => {
  for (const appointment of rows) {
    await logAppointmentEvent({ ...params, appointment });
  }
};

/**
 * Logs a status change for rows that ALREADY changed in the database. An audit failure
 * must not turn a completed change into an error response, so each failure is only reported.
 *
 * @param {Array<{ appointment: object, from: string }>} changes
 * @param {{ status: string, userId: string|null, ipAddress?: string, metadata?: object }} params
 */
export const logStatusChanges = async (changes, { status, userId, ipAddress = null, metadata = null }) => {
  for (const { appointment, from } of changes) {
    try {
      await logAppointmentEvent({ appointment, status, from, userId, ipAddress, metadata });
    } catch (error) {
      console.error('Appointment audit log failed:', error.message);
    }
  }
};

/**
 * Logs ONE `APPOINTMENT_RESCHEDULED` for a visit that moved to a new slot (the hidden old rows
 * produce no cancellation entry). Never throws: the move is already done.
 *
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-041
 * @param {object} p
 * @param {object[]} p.newRows   Rows of the new visit (at least one).
 * @param {string} p.previousCode  Visit code before the move.
 * @param {string} p.newCode       Visit code after the move.
 * @param {Date} p.fromAt  @param {Date} p.toAt
 * @param {string|null} p.userId  Customer user or staff user who moved it.
 * @param {string} [p.ipAddress]
 */
export const logRescheduled = async ({ newRows, previousCode, newCode, fromAt, toAt, userId, ipAddress = null }) => {
  try {
    await ActivityLog.log({
      eventType: ActivityEventType.APPOINTMENT_RESCHEDULED,
      performedBy: userId ?? null,
      targetModel: 'Appointment',
      targetId: newRows[0]._id,
      targetCode: newCode,
      changes: { before: { scheduledAt: fromAt }, after: { scheduledAt: toAt } },
      summary: `Visit ${previousCode} rescheduled as ${newCode}`,
      metadata: { previousVisitCode: previousCode },
      ipAddress,
    });
  } catch (error) {
    console.error('Appointment audit log failed:', error.message);
  }
};

export default { logAppointmentEvent, logAppointmentEvents, logStatusChanges, logRescheduled };
