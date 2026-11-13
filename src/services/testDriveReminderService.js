/**
 * @file testDriveReminderService.js
 * @description Sends the reminder email one hour before a test drive. An appointment
 * is claimed by setting reminderSentAt before sending, so overlapping scans cannot
 * both send it; a failed send clears the claim and the next scan tries again. If the
 * server dies between claim and send, that one reminder is lost, which is accepted:
 * the email is informational and the appointment is unaffected.
 *
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-049
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-050
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-047
 */

import Appointment from '../models/Appointment.js';
import { AppointmentType, TEST_DRIVE_ACTIVE_STATUSES, TEST_DRIVE_LIMITS } from '../constants/appConstants.js';
import logger from '../utils/logger.js';
import { sendReminderEmail } from './testDriveMail.js';

const MS_PER_MINUTE = 60 * 1000;

/** Checks the time again: a slow batch must not remind about a drive that has started. */
const claim = (id) => Appointment.findOneAndUpdate(
  { _id: id, status: { $in: TEST_DRIVE_ACTIVE_STATUSES }, reminderSentAt: null, scheduledAt: { $gt: new Date() } },
  { $set: { reminderSentAt: new Date() } },
  { new: true },
).lean();

const releaseClaim = (id) => Appointment.findOneAndUpdate({ _id: id }, { $unset: { reminderSentAt: 1 } }).lean();

/** Sends every reminder now due. A failure affects only that appointment. */
export const sendDueReminders = async () => {
  const now = new Date();
  const horizon = new Date(now.getTime() + TEST_DRIVE_LIMITS.REMINDER_LEAD_MINUTES * MS_PER_MINUTE);

  const due = await Appointment.find({
    type: AppointmentType.TEST_DRIVE,
    status: { $in: TEST_DRIVE_ACTIVE_STATUSES },
    scheduledAt: { $gt: now, $lte: horizon },
    reminderSentAt: null,
  }).select('_id').limit(TEST_DRIVE_LIMITS.JOB_BATCH_SIZE).lean();

  for (const { _id: id } of due) {
    const appointment = await claim(id);
    if (appointment) {
      try {
        await sendReminderEmail(appointment); // No address: the claim stays, so it is not re-read.
      } catch (error) {
        // Not error.message: SMTP replies can echo the recipient's address.
        logger.error(`Reminder email failed for appointment ${id}: ${error.code || error.name}`);
        await releaseClaim(id);
      }
    }
  }
};

export default { sendDueReminders };
