/**
 * @file testDriveJob.js
 * @description Periodic scan inside the server process: reminder emails, and
 * cancelling appointments whose car can no longer be sold. A scan is skipped while
 * the previous one is still running, and a failure in one part never stops the other.
 *
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-032
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-046
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-047
 */

import Appointment from '../models/Appointment.js';
import Car from '../models/Car.js';
import {
  AppointmentType, CarStatus, TEST_DRIVE_ACTIVE_STATUSES, TEST_DRIVE_CANCEL_TEXT, TEST_DRIVE_LIMITS,
} from '../constants/appConstants.js';
import { cancelAppointment } from '../services/testDriveCancellation.js';
import { sendDueReminders } from '../services/testDriveReminderService.js';
import logger from '../utils/logger.js';

/** Cancels upcoming appointments of cars that were sold or delisted. */
export const cancelForUnavailableCars = async () => {
  const upcoming = {
    type: AppointmentType.TEST_DRIVE,
    status: { $in: TEST_DRIVE_ACTIVE_STATUSES },
    scheduledAt: { $gt: new Date() },
  };

  const carIds = await Appointment.distinct('car', upcoming);
  if (carIds.length === 0) return;
  const gone = await Car.find({ _id: { $in: carIds }, status: { $in: [CarStatus.SOLD, CarStatus.DELISTED] } }).select('_id').lean();
  if (gone.length === 0) return;

  const affected = await Appointment.find({ ...upcoming, car: { $in: gone.map((car) => car._id) } })
    .select('_id').limit(TEST_DRIVE_LIMITS.JOB_BATCH_SIZE).lean();

  for (const { _id: id } of affected) {
    try {
      await cancelAppointment({ filter: { _id: id }, reason: TEST_DRIVE_CANCEL_TEXT.CAR_UNAVAILABLE, actor: null });
    } catch (error) {
      // The next scan picks this one up again; the rest of the batch still runs.
      logger.error(`Could not cancel appointment ${id} for an unavailable car: ${error.message}`);
    }
  }
};

/** Runs both parts once. Never throws: a rejection here would take the server down. */
export const runTestDriveJobOnce = async () => {
  for (const part of [sendDueReminders, cancelForUnavailableCars]) {
    try {
      await part();
    } catch (error) {
      logger.error(`Test-drive job step ${part.name} failed: ${error.message}`);
    }
  }
};

let timer = null;
let running = false;

export const startTestDriveJob = () => {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    await runTestDriveJobOnce();
    running = false;
  }, TEST_DRIVE_LIMITS.JOB_INTERVAL_MS);
  timer.unref(); // Must not keep the process alive on its own.
};

export const stopTestDriveJob = () => {
  clearInterval(timer);
  timer = null;
};

export default { runTestDriveJobOnce, startTestDriveJob, stopTestDriveJob, cancelForUnavailableCars };
