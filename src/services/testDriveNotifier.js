/**
 * @file testDriveNotifier.js
 * @description Tells connected clients that a test drive changed, so they fetch fresh data
 * from the API. Call it only after the change is saved. Messages carry no personal data,
 * and a failure here never affects the change that caused it.
 *
 * @ears .sdd/features/test-drive-realtime/SPEC.md#REQ-007
 * @ears .sdd/features/test-drive-realtime/SPEC.md#REQ-008
 * @ears .sdd/features/test-drive-realtime/SPEC.md#REQ-009
 * @ears .sdd/features/test-drive-realtime/SPEC.md#REQ-010
 * @ears .sdd/features/test-drive-realtime/SPEC.md#REQ-012
 */

import { STAFF_ROOM, customerRoom, getRealtime, slotsRoom } from '../config/realtime.js';
import logger from '../utils/logger.js';
import { toLocalDate } from './testDriveSlots.js';

let warnedNotRunning = false;

/** @param {{_id: *, customer: *, status: string, scheduledAt: Date}} appointment */
export const notifyAppointmentChanged = (appointment) => {
  try {
    const realtime = getRealtime();
    if (!realtime) {
      // Once: every change would repeat it while realtime is down, as during shutdown.
      if (!warnedNotRunning) logger.warn('Realtime is not running; test-drive changes are not being notified.');
      warnedNotRunning = true;
      return;
    }

    const date = toLocalDate(appointment.scheduledAt);
    const change = { id: String(appointment._id), status: appointment.status };
    // By day, not by car: one booking can use up the capacity or staff of every car that day.
    realtime.to(slotsRoom(date)).emit('slots-changed', { date });
    realtime.to(STAFF_ROOM).emit('appointment-changed', change);
    realtime.to(customerRoom(appointment.customer)).emit('my-appointment-changed', change);
  } catch (error) {
    logger.error(`Realtime notification failed for appointment ${appointment._id}: ${error.message}`);
  }
};

export default { notifyAppointmentChanged };
