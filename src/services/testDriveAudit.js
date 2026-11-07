/**
 * @file testDriveAudit.js
 * @description Audit entries for test-drive changes. Written in the same transaction
 * as the change, so an audit failure rolls the change back. A null actor means the
 * scheduled job did it.
 *
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#NFR-06
 */

import ActivityLog from '../models/ActivityLog.js';

/**
 * @param {object} params
 * @param {string} params.eventType - ActivityEventType value.
 * @param {object} params.appointment - Stored appointment after the change.
 * @param {string} params.summary
 * @param {{_id: *, email?: string}|null} params.actor
 * @param {import('mongoose').ClientSession} params.session
 */
export const logAppointmentEvent = ({ eventType, appointment, summary, actor, session }) =>
  ActivityLog.create([{
    eventType,
    performedBy: actor?._id ?? null,
    performedByEmail: actor?.email ?? null,
    targetModel: 'Appointment',
    targetId: appointment._id,
    targetCode: appointment.appointmentCode ?? null,
    summary,
  }], { session, ordered: true });

export default { logAppointmentEvent };
