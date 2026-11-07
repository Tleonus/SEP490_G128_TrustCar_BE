/**
 * @file testDriveStaffService.js
 * @description Staff handling of test drives. Every status change is a conditional
 * update following the transition table in the Spec, so concurrent actions cannot
 * apply twice, and is audited in the same transaction.
 *
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-020
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-033
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-038
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-039
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-040
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-041
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-042
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-043
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-044
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-053
 */

import Appointment from '../models/Appointment.js';
import {
  ActivityEventType as Event, AppointmentStatus as Status, AppointmentType, CarStatus,
  TEST_DRIVE_ACTIVE_STATUSES, TEST_DRIVE_CANCEL_TEXT,
} from '../constants/appConstants.js';
import { AppError, buildPaginationMeta } from '../utils/apiResponse.js';
import { withTransaction } from '../utils/withTransaction.js';
import { appointmentEnd, assertStaffAssignable } from './testDriveAssignment.js';
import { logAppointmentEvent } from './testDriveAudit.js';
import { cancelAppointment } from './testDriveCancellation.js';
import { sendBookingConfirmedEmail } from './testDriveMail.js';
import { retryOnWriteConflict } from './testDriveRetry.js';
import { localDayRange, toLocalIso } from './testDriveSlots.js';

const notFound = () => new AppError('Test drive not found.', 404, 'TEST_DRIVE_NOT_FOUND');
const invalidTransition = () => new AppError('This action is not allowed for the test drive right now.', 409, 'INVALID_TRANSITION');

const loadAppointment = async (id) => {
  const appointment = await Appointment.findOne({ _id: id, type: AppointmentType.TEST_DRIVE }).lean();
  if (!appointment) throw notFound();
  return appointment;
};

/** Why an appointment needs attention; computed on read so it can never go stale. */
const attentionReasons = (appointment, now) => {
  const reasons = [];
  const holding = TEST_DRIVE_ACTIVE_STATUSES.includes(appointment.status);
  if (!holding) return reasons;
  if (appointment.status === Status.PENDING && appointmentEnd(appointment) <= now) reasons.push('PENDING_OVERDUE');
  if ([CarStatus.RESERVED, CarStatus.MAINTENANCE].includes(appointment.car?.status)) reasons.push('CAR_ON_HOLD');
  if (appointment.assignedTo && !appointment.assignedTo.isActive) reasons.push('STAFF_INACTIVE');
  return reasons;
};

const toStaffView = (appointment, now) => {
  const reasons = attentionReasons(appointment, now);
  return {
    id: String(appointment._id),
    appointmentCode: appointment.appointmentCode,
    customer: appointment.customer && { id: String(appointment.customer._id), fullName: appointment.customer.fullName, phone: appointment.customer.phone },
    car: appointment.car && { id: String(appointment.car._id), make: appointment.car.make, model: appointment.car.model, year: appointment.car.year, status: appointment.car.status },
    assignedTo: appointment.assignedTo && { id: String(appointment.assignedTo._id), fullName: appointment.assignedTo.fullName },
    scheduledAt: toLocalIso(appointment.scheduledAt),
    durationMinutes: appointment.durationMinutes,
    status: appointment.status,
    notes: appointment.notes,
    outcome: appointment.outcome,
    cancellationReason: appointment.cancellationReason ?? null,
    needsAttention: reasons.length > 0,
    attentionReasons: reasons,
  };
};

/**
 * @param {object} query - status, date (YYYY-MM-DD), staffId, needsAttention
 * @param {{page: number, limit: number, skip: number}} paging
 */
export const listAppointments = async ({ status, date, staffId, needsAttention }, { page, limit, skip }) => {
  const filter = { type: AppointmentType.TEST_DRIVE };
  if (status) filter.status = status;
  if (staffId) filter.assignedTo = staffId;
  if (date) {
    const { start, end } = localDayRange(date);
    filter.scheduledAt = { $gte: start, $lt: end };
  }

  const load = (query) => query
    .populate('customer', 'fullName phone')
    .populate('car', 'make model year status')
    .populate('assignedTo', 'fullName isActive')
    .sort({ scheduledAt: 1, _id: 1 }) // Several appointments share a start time; _id keeps pages stable.
    .lean();
  const now = new Date();

  // The flag is computed, so this filter runs in memory; only holding appointments can carry it.
  if (needsAttention !== undefined) {
    const holding = status ? filter : { ...filter, status: { $in: TEST_DRIVE_ACTIVE_STATUSES } };
    const pool = needsAttention ? await load(Appointment.find(holding)) : await load(Appointment.find(filter));
    const views = pool.map((a) => toStaffView(a, now)).filter((view) => view.needsAttention === needsAttention);
    return { items: views.slice(skip, skip + limit), pagination: buildPaginationMeta(views.length, page, limit) };
  }

  const [appointments, total] = await Promise.all([
    load(Appointment.find(filter).skip(skip).limit(limit)),
    Appointment.countDocuments(filter),
  ]);
  return { items: appointments.map((a) => toStaffView(a, now)), pagination: buildPaginationMeta(total, page, limit) };
};

/** Applies one conditional change and its audit entry together. */
const applyChange = async ({ id, condition, update, eventType, summary, actor, afterCommit }) => {
  const changed = await retryOnWriteConflict(() => withTransaction(async (session) => {
    const appointment = await Appointment.findOneAndUpdate(
      { _id: id, type: AppointmentType.TEST_DRIVE, ...condition },
      { ...update, $set: { ...update.$set, updatedBy: actor._id } },
      { new: true, session },
    ).lean();
    if (appointment) await logAppointmentEvent({ eventType, appointment, actor, summary, session });
    return appointment;
  }));
  if (!changed) throw invalidTransition();
  if (afterCommit) await afterCommit(changed);
  return { id: String(changed._id), status: changed.status };
};

const holding = { status: { $in: TEST_DRIVE_ACTIVE_STATUSES } };

export const reassign = async (id, staffId, actor) => {
  const appointment = await loadAppointment(id);
  if (!TEST_DRIVE_ACTIVE_STATUSES.includes(appointment.status)) throw invalidTransition();
  await assertStaffAssignable(staffId, appointment);

  try {
    return await applyChange({
      id, actor, condition: holding, update: { $set: { assignedTo: staffId } },
      eventType: Event.APPOINTMENT_REASSIGNED, summary: 'Test drive reassigned',
    });
  } catch (error) {
    // Someone else gave this staff member the same time while we were checking.
    if (error.code === 11000) throw new AppError('The selected staff member already has a test drive at this time.', 409, 'STAFF_NOT_AVAILABLE');
    throw error;
  }
};

export const confirm = async (id, actor) => {
  const appointment = await loadAppointment(id);
  const now = new Date();
  if (appointment.status !== Status.PENDING || appointmentEnd(appointment) <= now) throw invalidTransition();
  return applyChange({
    id, actor, condition: { status: Status.PENDING },
    update: { $set: { status: Status.CONFIRMED, confirmedBy: actor._id, confirmedAt: now } },
    eventType: Event.APPOINTMENT_CONFIRMED, summary: 'Test drive confirmed',
    afterCommit: sendBookingConfirmedEmail,
  });
};

/** Outcomes apply once the appointment has started, and end its hold on the slot. */
const startedConfirmed = () => ({ status: Status.CONFIRMED, scheduledAt: { $lte: new Date() } });

export const complete = async (id, outcome, actor) => {
  await loadAppointment(id);
  return applyChange({
    id, actor, condition: startedConfirmed(),
    update: { $set: { status: Status.COMPLETED, completedAt: new Date(), outcome }, $unset: { slotSeat: 1 } },
    eventType: Event.APPOINTMENT_COMPLETED, summary: 'Test drive completed',
  });
};

export const markNoShow = async (id, actor) => {
  await loadAppointment(id);
  return applyChange({
    id, actor, condition: startedConfirmed(),
    update: { $set: { status: Status.NO_SHOW }, $unset: { slotSeat: 1 } },
    eventType: Event.APPOINTMENT_NO_SHOW, summary: 'Customer did not attend',
  });
};

export const correctNoShow = async (id, outcome, actor) => {
  const appointment = await loadAppointment(id);
  return applyChange({
    id, actor, condition: { status: Status.NO_SHOW },
    // The drive happened at its scheduled time, whenever the correction is made.
    update: { $set: { status: Status.COMPLETED, completedAt: appointmentEnd(appointment), outcome } },
    eventType: Event.APPOINTMENT_NO_SHOW_CORRECTED, summary: 'No-show corrected to completed',
  });
};

export const staffCancel = async (id, { reasonCode, note }, actor) => {
  await loadAppointment(id);
  const reason = note ? `${TEST_DRIVE_CANCEL_TEXT[reasonCode]}: ${note}` : TEST_DRIVE_CANCEL_TEXT[reasonCode];
  const cancelled = await cancelAppointment({ filter: { _id: id }, reason, actor });
  if (!cancelled) throw invalidTransition();
  return { id: String(cancelled._id), status: cancelled.status };
};

export default { listAppointments, reassign, confirm, complete, markNoShow, correctNoShow, staffCancel };
