/**
 * @file testDriveCustomerService.js
 * @description A customer's own test drives. Responses list their fields explicitly,
 * so staff and audit data on the appointment can never reach the customer.
 *
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-034
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-035
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-036
 */

import Appointment from '../models/Appointment.js';
import { AppointmentType, TEST_DRIVE_CANCEL_TEXT } from '../constants/appConstants.js';
import { AppError, buildPaginationMeta } from '../utils/apiResponse.js';
import { cancelAppointment } from './testDriveCancellation.js';
import { toLocalIso } from './testDriveSlots.js';

const toCustomerView = (appointment) => ({
  id: String(appointment._id),
  appointmentCode: appointment.appointmentCode,
  car: appointment.car && {
    id: String(appointment.car._id),
    make: appointment.car.make,
    model: appointment.car.model,
    year: appointment.car.year,
  },
  scheduledAt: toLocalIso(appointment.scheduledAt),
  durationMinutes: appointment.durationMinutes,
  location: appointment.location,
  status: appointment.status,
  cancellationReason: appointment.cancellationReason ?? null,
});

/**
 * @param {{customer?: *}} user
 * @param {{page: number, limit: number, skip: number}} paging
 * @returns {Promise<{items: object[], pagination: object}>}
 */
export const listMine = async (user, { page, limit, skip }) => {
  if (!user.customer) return { items: [], pagination: buildPaginationMeta(0, page, limit) };

  const filter = { customer: user.customer, type: AppointmentType.TEST_DRIVE };
  const [appointments, total] = await Promise.all([
    Appointment.find(filter).populate('car', 'make model year').sort({ scheduledAt: -1 }).skip(skip).limit(limit).lean(),
    Appointment.countDocuments(filter),
  ]);
  return { items: appointments.map(toCustomerView), pagination: buildPaginationMeta(total, page, limit) };
};

/**
 * Cancels the customer's own appointment before it starts. Someone else's
 * appointment reads as not found, so its existence is not revealed.
 * @throws {AppError} 404 TEST_DRIVE_NOT_FOUND, 409 INVALID_TRANSITION
 */
export const cancelMine = async (user, appointmentId) => {
  const owned = { _id: appointmentId, customer: user.customer ?? null };
  const cancelled = await cancelAppointment({
    filter: { ...owned, scheduledAt: { $gt: new Date() } },
    reason: TEST_DRIVE_CANCEL_TEXT.CUSTOMER_CANCELLED,
    actor: user,
    notify: false, // The customer did this themselves.
  });

  if (cancelled) {
    return { id: String(cancelled._id), status: cancelled.status, cancellationReason: cancelled.cancellationReason };
  }

  const existing = await Appointment.findOne({ ...owned, type: AppointmentType.TEST_DRIVE }).select('_id').lean();
  if (!existing) throw new AppError('Test drive not found.', 404, 'TEST_DRIVE_NOT_FOUND');
  throw new AppError('This test drive can no longer be cancelled.', 409, 'INVALID_TRANSITION');
};

export default { listMine, cancelMine };
