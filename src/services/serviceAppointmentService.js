/**
 * @file serviceAppointmentService.js
 * @description KAN-96 service-appointment booking flow.
 *
 * A SERVICE appointment books ONE showroom service package at ONE fixed slot.
 * Unlike a test-drive visit it does not bind to a showroom car (the customer
 * brings their own vehicle, identified by `serviceVehiclePlate`).
 *
 * Slot capacity is SHARED with test-drive visits: at any slot, the number of
 * open test-drive visits PLUS open service appointments must stay within
 * `testDrive.maxGuestsPerSlot`. A customer can hold at most one open service
 * appointment per slot — the partial unique index `uniq_service_open_per_customer_slot`
 * enforces that at the database, and the service layer translates the duplicate
 * key into a clean business error.
 *
 * The service snapshot (code, name, price, duration) is frozen at booking time
 * so a later admin edit of the package does not retroactively change what the
 * customer booked.
 */

import Appointment from '../models/Appointment.js';
import Customer from '../models/Customer.js';
import {
  ActivityEventType, AppointmentStatus, AppointmentType,
} from '../constants/appConstants.js';
import { OPEN_STATUSES, SHOWROOM_LOCATION, VISIT_DURATION_MIN, SLOT_QUERY_MAX_DAYS } from '../constants/appointmentRules.js';
import { AppError, parsePagination, buildPaginationMeta } from '../utils/apiResponse.js';
import { withTransaction } from '../utils/withTransaction.js';
import { assertBookableTime, slotStartsForDate, windowReason, parseDateKey, formatVnIso } from './appointmentSlotRules.js';
import { getSlotCapacity } from './appointmentCapacity.js';
import { allocateCodes } from './appointmentWrite.js';
import { findOpenAtSlot } from './appointmentQueries.js';
import { groupIntoVisits } from './appointmentVisitRules.js';
import { resolveBookableService } from './showroomServiceService.js';
import ActivityLog from '../models/ActivityLog.js';

const OPEN_SERVICE_FILTER = {
  type: AppointmentType.SERVICE,
  status: { $in: OPEN_STATUSES },
  isActive: true,
};

/** Count of open SERVICE appointments whose scheduledAt falls in [from, toExclusive). */
export const countServiceInRange = async (from, toExclusive, { session = null } = {}) => {
  const rows = await Appointment.find({
    ...OPEN_SERVICE_FILTER,
    scheduledAt: { $gte: from, $lt: toExclusive },
  }).select('scheduledAt').session(session).lean();
  const counts = new Map();
  rows.forEach((row) => {
    const key = new Date(row.scheduledAt).getTime();
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
};

/** Count of open SERVICE appointments at exactly one slot instant. */
export const countServiceAtSlot = async (scheduledAt, { session = null } = {}) => {
  const count = await Appointment.countDocuments({
    ...OPEN_SERVICE_FILTER,
    scheduledAt,
  }).session(session);
  return count;
};

/**
 * Number of test-drive visits (distinct customers) holding the slot open.
 * Reuses the existing visit grouping so a visit of 3 cars counts as ONE.
 */
const countTestDriveVisitsAtSlot = async (scheduledAt, { session = null } = {}) => {
  const rows = await findOpenAtSlot(scheduledAt, { session });
  // Service rows don't have a car; groupIntoVisits only sees rows that hold a car.
  const tdRows = rows.filter((row) => row.car);
  return groupIntoVisits(tdRows).length;
};

const duplicateServiceSlot = () => new AppError(
  'You already have a service appointment at this time slot.',
  409,
  'ALREADY_BOOKED_SERVICE',
);

const slotFull = () => new AppError(
  'This time slot is full. Please choose another slot.',
  409,
  'SLOT_FULL',
);

const isServiceSlotDuplicate = (error) =>
  error?.code === 11000 && String(error?.message || '').includes('uniq_service_open_per_customer_slot');

/** Allow-list DTO returned to the customer. */
export const toCustomerServiceAppointment = (row) => ({
  id: String(row._id),
  appointmentCode: row.appointmentCode,
  type: AppointmentType.SERVICE,
  status: row.status,
  scheduledAt: formatVnIso(new Date(row.scheduledAt)),
  durationMinutes: row.durationMinutes ?? null,
  location: row.location ?? null,
  service: {
    id: row.service ? String(row.service) : null,
    code: row.serviceSnapshot?.code ?? null,
    serviceName: row.serviceSnapshot?.serviceName ?? null,
    referencePrice: row.serviceSnapshot?.referencePrice ?? null,
    estimatedMinutes: row.serviceSnapshot?.estimatedMinutes ?? null,
  },
  vehiclePlate: row.serviceVehiclePlate ?? null,
  notes: row.notes ?? null,
  createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  cancellation: row.status === AppointmentStatus.CANCELLED ? {
    reason: row.cancellationReason ?? null,
    at: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  } : null,
});

/**
 * Slot grid for the service booking wizard.
 * Each slot reports { start, available, reason } where reason is one of
 * TOO_SOON / TOO_FAR / ALREADY_BOOKED / CAPACITY_FULL or null when bookable.
 *
 * @param {object} params
 * @param {string} params.customerId
 * @param {string} params.from - YYYY-MM-DD (VN)
 * @param {string} params.to   - YYYY-MM-DD (VN), inclusive
 * @param {Date}   [params.now]
 */
export const listServiceSlots = async ({ customerId, from, to, now = new Date() }) => {
  const fromParts = parseDateKey(from);
  const toParts   = parseDateKey(to);
  if (!fromParts || !toParts) {
    throw new AppError('from and to must be valid YYYY-MM-DD dates.', 422, 'VALIDATION_ERROR');
  }
  const fromDate = new Date(Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day));
  const toDate   = new Date(Date.UTC(toParts.year,   toParts.month - 1,   toParts.day));
  const daySpan  = Math.round((toDate - fromDate) / (24 * 60 * 60 * 1000));
  if (daySpan < 0 || daySpan > SLOT_QUERY_MAX_DAYS) {
    throw new AppError(`Date range must be between 0 and ${SLOT_QUERY_MAX_DAYS} days.`, 422, 'VALIDATION_ERROR');
  }

  const starts = [];
  for (let d = 0; d <= daySpan; d += 1) {
    const cursor = new Date(fromDate.getTime() + d * 24 * 60 * 60 * 1000);
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-${String(cursor.getUTCDate()).padStart(2, '0')}`;
    starts.push(...slotStartsForDate(key));
  }
  if (starts.length === 0) return { days: [] };

  const rangeFrom = starts[0];
  const rangeTo   = new Date(starts[starts.length - 1].getTime() + 60 * 1000);

  const [capacity, serviceCounts, ownServiceRows, tdRows] = await Promise.all([
    getSlotCapacity(),
    countServiceInRange(rangeFrom, rangeTo),
    Appointment.find({
      ...OPEN_SERVICE_FILTER,
      customer: customerId,
      scheduledAt: { $gte: rangeFrom, $lt: rangeTo },
    }).select('scheduledAt').lean(),
    // Test-drive rows share the slot capacity; a visit of several cars counts as one.
    Appointment.find({
      type: { $ne: AppointmentType.SERVICE },
      status: { $in: OPEN_STATUSES },
      isActive: true,
      scheduledAt: { $gte: rangeFrom, $lt: rangeTo },
    }).select('scheduledAt customer car').lean(),
  ]);

  const ownSlots = new Set(ownServiceRows.map((row) => new Date(row.scheduledAt).getTime()));

  // Group test-drive rows into visits per slot so a 3-car visit counts as 1.
  const tdBySlot = new Map();
  tdRows.forEach((row) => {
    const key = new Date(row.scheduledAt).getTime();
    if (!tdBySlot.has(key)) tdBySlot.set(key, []);
    tdBySlot.get(key).push(row);
  });

  const days = new Map();
  starts.forEach((start) => {
    const key = start.getTime();
    const dateKey = formatVnIso(start).slice(0, 10);
    const reason = windowReason(start, now);
    let finalReason = reason;
    if (!finalReason && ownSlots.has(key)) finalReason = 'ALREADY_BOOKED';
    if (!finalReason) {
      const serviceTaken = serviceCounts.get(key) || 0;
      const tdTaken = groupIntoVisits(tdBySlot.get(key) || []).length;
      if (serviceTaken + tdTaken >= capacity) finalReason = 'CAPACITY_FULL';
    }
    const slot = {
      start: formatVnIso(start),
      available: finalReason === null,
      reason: finalReason,
    };
    if (!days.has(dateKey)) days.set(dateKey, []);
    days.get(dateKey).push(slot);
  });

  return {
    days: [...days.entries()].map(([date, slots]) => ({ date, slots })),
    capacity,
  };
};

/**
 * Creates a SERVICE appointment for a customer at one fixed slot.
 * @param {object} params
 * @param {string} params.customerId
 * @param {string} params.userId
 * @param {string} params.serviceId
 * @param {Date}   params.scheduledAt
 * @param {string} params.serviceVehiclePlate
 * @param {string|null} [params.notes]
 * @param {Date}   [params.now]
 */
export const createServiceAppointment = async ({
  customerId, userId, serviceId, scheduledAt, serviceVehiclePlate, notes = null, now = new Date(),
}) => {
  assertBookableTime(scheduledAt, now);
  const service = await resolveBookableService(serviceId);
  const capacity = await getSlotCapacity();

  const book = (session) => withTransaction(async (session) => {
    const touched = await Customer.updateOne(
      { _id: customerId }, { $set: { updatedAt: new Date() } }, { session },
    );
    if (touched.matchedCount === 0) {
      throw new AppError('Customer record not found.', 404, 'CUSTOMER_NOT_FOUND');
    }

    const [serviceTaken, tdTaken] = await Promise.all([
      countServiceAtSlot(scheduledAt, { session }),
      countTestDriveVisitsAtSlot(scheduledAt, { session }),
    ]);
    if (serviceTaken + tdTaken >= capacity) throw slotFull();

    const [code] = await allocateCodes(1);
    let created;
    try {
      [created] = await Appointment.create([{
        appointmentCode: code,
        customer: customerId,
        car: null,
        type: AppointmentType.SERVICE,
        status: AppointmentStatus.PENDING,
        scheduledAt,
        durationMinutes: VISIT_DURATION_MIN,
        location: SHOWROOM_LOCATION,
        notes: notes && notes.trim() ? notes.trim() : null,
        service: service._id,
        serviceSnapshot: {
          code: service.code,
          serviceName: service.serviceName,
          referencePrice: service.referencePrice,
          estimatedMinutes: service.estimatedDuration,
        },
        serviceVehiclePlate,
        createdBy: userId,
      }], { session });
    } catch (error) {
      if (isServiceSlotDuplicate(error)) throw duplicateServiceSlot();
      throw error;
    }

    await ActivityLog.create([{
      eventType: ActivityEventType.SERVICE_APPOINTMENT_CREATED,
      performedBy: userId,
      targetModel: 'Appointment',
      targetId: created._id,
      targetCode: created.appointmentCode,
      summary: `Service appointment created: ${service.serviceName}`,
      metadata: { serviceId: String(service._id), serviceCode: service.code },
    }], { session });

    return typeof created?.toObject === 'function' ? created.toObject() : created;
  });

  // `book` wraps its own transaction; the outer signature keeps a stable shape
  // for callers and tests that pass a session for integration coverage.
  const created = await book(null);
  // Mongoose documents expose toObject(); the in-memory test double returns a plain object.
  const stored = typeof created?.toObject === 'function' ? created.toObject() : created;
  return toCustomerServiceAppointment(stored);
};

/** Lists the customer's own SERVICE appointments, newest first. */
export const listMyServiceAppointments = async ({ customerId, query }) => {
  const { page, limit, skip } = parsePagination(query, 50);
  const filter = { customer: customerId, type: AppointmentType.SERVICE, isActive: true };
  if (query.status) filter.status = query.status;
  const [total, rows] = await Promise.all([
    Appointment.countDocuments(filter),
    Appointment.find(filter).sort({ scheduledAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return {
    items: rows.map(toCustomerServiceAppointment),
    pagination: buildPaginationMeta(total, page, limit),
  };
};

/**
 * Customer cancels their own open SERVICE appointment.
 * Late cancellation (< 2h before the slot) is still allowed but flagged via the
 * reason prefix so staff can see it; the row itself moves to CANCELLED.
 */
export const cancelMyServiceAppointment = async ({ customerId, userId, id, reason = null, now = new Date() }) => {
  const row = await Appointment.findOne({
    _id: id, customer: customerId, type: AppointmentType.SERVICE, isActive: true,
  }).lean();
  if (!row) throw new AppError('Service appointment not found.', 404, 'SERVICE_APPOINTMENT_NOT_FOUND');
  if (![AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED].includes(row.status)) {
    throw new AppError('Only a pending or confirmed service appointment can be cancelled.', 409, 'SERVICE_APPOINTMENT_NOT_CANCELLABLE');
  }

  const hoursAhead = (new Date(row.scheduledAt).getTime() - now.getTime()) / (60 * 60 * 1000);
  const late = hoursAhead < 2;
  const trimmed = reason && reason.trim() ? reason.trim() : null;
  const storedReason = late ? `LATE: ${trimmed || 'Customer cancelled within 2 hours.'}` : trimmed;

  const updated = await Appointment.findOneAndUpdate(
    { _id: id, status: { $in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] } },
    {
      $set: {
        status: AppointmentStatus.CANCELLED,
        cancellationReason: storedReason,
        updatedBy: userId,
      },
    },
    { new: true },
  ).lean();
  if (!updated) {
    throw new AppError('Service appointment changed state before it could be cancelled.', 409, 'SERVICE_APPOINTMENT_NOT_CANCELLABLE');
  }

  await ActivityLog.create({
    eventType: ActivityEventType.SERVICE_APPOINTMENT_CANCELLED,
    performedBy: userId,
    targetModel: 'Appointment',
    targetId: updated._id,
    targetCode: updated.appointmentCode,
    summary: 'Service appointment cancelled by customer',
    metadata: { late, reason: storedReason },
  });

  return toCustomerServiceAppointment(updated);
};

export default {
  countServiceInRange, countServiceAtSlot,
  listServiceSlots, createServiceAppointment,
  listMyServiceAppointments, cancelMyServiceAppointment,
  toCustomerServiceAppointment,
};
