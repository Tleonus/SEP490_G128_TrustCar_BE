/**
 * @file testDriveAssignment.js
 * @description Chooses and validates the sales staff responsible for a test drive.
 *
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-019
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-021
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-051
 */

import User from '../models/User.js';
import Appointment from '../models/Appointment.js';
import { AppError } from '../utils/apiResponse.js';
import { AppointmentType, Roles, TEST_DRIVE_ACTIVE_STATUSES } from '../constants/appConstants.js';
import { overlaps, toLocalDate } from './testDriveSlots.js';

const MS_PER_MINUTE = 60 * 1000;
const MAX_DURATION_MS = 480 * MS_PER_MINUTE; // Appointment.durationMinutes upper bound

/** End instant of a stored appointment. */
export const appointmentEnd = (appointment) =>
  new Date(appointment.scheduledAt.getTime() + appointment.durationMinutes * MS_PER_MINUTE);

/** Whether a stored appointment overlaps a time range. */
export const appointmentOverlaps = (appointment, startAt, endAt) =>
  overlaps(appointment.scheduledAt, appointmentEnd(appointment), startAt, endAt);

/**
 * Lower bound for a query on `scheduledAt`, far enough back to include an
 * appointment that started earlier and is still running at `startAt`.
 */
export const overlapQueryStart = (startAt) => new Date(startAt.getTime() - MAX_DURATION_MS);

/** Ids of all active sales staff. */
export const listActiveStaffIds = async () => {
  const staff = await User.find({ roleName: Roles.SALES_STAFF, isActive: true }).select('_id').lean();
  return staff.map((member) => String(member._id));
};

/**
 * Active sales staff to choose from when handing over a test drive, with no contact details.
 * Sorted here because MongoDB's default order puts accented names (Ánh, Đỗ) after Z.
 */
export const listAssignableStaff = async () => {
  const staff = await User.find({ roleName: Roles.SALES_STAFF, isActive: true }).select('fullName').lean();
  return staff
    .map((member) => ({ id: String(member._id), fullName: member.fullName }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'vi'));
};

/**
 * Picks the free staff member with the fewest appointments that day. Ties go to
 * the first in the list, so the choice is deterministic.
 *
 * @param {object} params
 * @param {Date} params.startAt
 * @param {Date} params.endAt
 * @param {string[]} params.staffIds - Active sales staff.
 * @param {Array} params.dayAppointments - Holding appointments of that day.
 * @returns {string|null} staff id, or null when everyone is busy
 */
export const pickFreeStaff = ({ startAt, endAt, staffIds, dayAppointments }) => {
  const busy = new Set(dayAppointments
    .filter((appointment) => appointmentOverlaps(appointment, startAt, endAt))
    .map((appointment) => String(appointment.assignedTo)));
  // The list can reach back into the previous evening to catch long overlaps; only this day counts as load.
  const date = toLocalDate(startAt);
  const load = (staffId) => dayAppointments
    .filter((appointment) => String(appointment.assignedTo) === staffId && toLocalDate(appointment.scheduledAt) === date)
    .length;

  return staffIds
    .filter((staffId) => !busy.has(staffId))
    .reduce((best, staffId) => (best === null || load(staffId) < load(best) ? staffId : best), null);
};

/**
 * Checks a staff member can take an appointment.
 * @throws {AppError} 422 STAFF_INVALID, 409 STAFF_NOT_AVAILABLE
 */
export const assertStaffAssignable = async (staffId, appointment) => {
  const staff = await User.findById(staffId).select('roleName isActive').lean();
  if (!staff || staff.roleName !== Roles.SALES_STAFF || !staff.isActive) {
    throw new AppError('The selected staff member is not active sales staff.', 422, 'STAFF_INVALID');
  }

  const endAt = appointmentEnd(appointment);
  const others = await Appointment.find({
    type: AppointmentType.TEST_DRIVE,
    assignedTo: staffId,
    status: { $in: TEST_DRIVE_ACTIVE_STATUSES },
    scheduledAt: { $gte: overlapQueryStart(appointment.scheduledAt), $lt: endAt },
    _id: { $ne: appointment._id },
  }).select('scheduledAt durationMinutes').lean();

  if (others.some((other) => appointmentOverlaps(other, appointment.scheduledAt, endAt))) {
    throw new AppError('The selected staff member already has a test drive at this time.', 409, 'STAFF_NOT_AVAILABLE');
  }
};

export default { pickFreeStaff, assertStaffAssignable, listActiveStaffIds, listAssignableStaff, appointmentEnd, appointmentOverlaps, overlapQueryStart };
