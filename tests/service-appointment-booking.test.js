/**
 * @file service-appointment-booking.test.js
 * @description KAN-96 service appointment booking: happy path, the time guards shared with
 * test-drive, the shared slot capacity, the one-open-service-per-customer-per-slot rule,
 * the frozen price snapshot, cancellation and the slot grid.
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import {
  createServiceAppointment, cancelMyServiceAppointment, listServiceSlots, listMyServiceAppointments,
} from '../src/services/serviceAppointmentService.js';

const fakes = await setupAppointmentFakes();

const NOW = new Date('2026-11-08T00:00:00Z');
const SLOT = new Date('2026-11-10T03:00:00Z'); // 10:00 VN
const OTHER_SLOT = new Date('2026-11-10T06:00:00Z'); // 13:00 VN
const userId = new mongoose.Types.ObjectId();
let customer;
let service;

beforeEach(() => {
  fakes.reset();
  fakes.enableIndexes('service');
  fakes.capacity = 3;
  customer = fakes.addCustomer();
  service = fakes.addService({
    code: 'POLISH', serviceName: 'Đánh bóng sơn', referencePrice: 800_000, estimatedDuration: 180,
  });
});

const book = (extra = {}) => createServiceAppointment({
  userId, customerId: customer._id, serviceId: service._id,
  scheduledAt: SLOT, serviceVehiclePlate: '51k-123.45', now: NOW, ...extra,
});
const reject = (promise) => promise.then(() => null, (error) => error);

describe('happy path', () => {
  it('creates one PENDING service appointment with a frozen snapshot and no car', async () => {
    const dto = await book({ notes: '  Xe dính nhựa đường  ' });
    expect(fakes.appointments).toHaveLength(1);
    const row = fakes.appointments[0];
    expect(row).toMatchObject({
      type: 'SERVICE', status: 'PENDING', car: null, durationMinutes: 90,
      serviceVehiclePlate: '51K-123.45', notes: 'Xe dính nhựa đường',
      location: 'Showroom TrustCar, Quận 1, TP. Hồ Chí Minh',
    });
    expect(row.serviceSnapshot).toMatchObject({
      code: 'POLISH', serviceName: 'Đánh bóng sơn', referencePrice: 800_000, estimatedMinutes: 180,
    });
    expect(dto).toMatchObject({ type: 'SERVICE', status: 'PENDING', vehiclePlate: '51K-123.45' });
    expect(dto.service).toMatchObject({ code: 'POLISH', referencePrice: 800_000 });
    expect(dto.scheduledAt).toBe('2026-11-10T10:00:00+07:00');
  });

  it('writes one audit row', async () => {
    await book();
    expect(fakes.activityLogs).toHaveLength(1);
    expect(fakes.activityLogs[0]).toMatchObject({
      eventType: 'SERVICE_APPOINTMENT_CREATED', targetModel: 'Appointment', performedBy: userId,
    });
  });

  it('keeps the booked price after the package price changes', async () => {
    const dto = await book();
    service.referencePrice = 1_500_000;
    const { items } = await listMyServiceAppointments({ customerId: customer._id, query: {} });
    expect(items[0].service.referencePrice).toBe(dto.service.referencePrice);
    expect(items[0].service.referencePrice).toBe(800_000);
  });
});

describe('guards', () => {
  it.each([
    ['too soon', { scheduledAt: new Date(NOW.getTime() + 3600e3) }, 'APPOINTMENT_TOO_SOON'],
    ['too far', { scheduledAt: new Date(NOW.getTime() + 61 * 86400e3) }, 'APPOINTMENT_TOO_FAR'],
    ['off slot', { scheduledAt: new Date('2026-11-10T02:00:00Z') }, 'APPOINTMENT_SLOT_INVALID'],
  ])('%s → %s and nothing is created', async (_name, extra, code) => {
    const error = await reject(book(extra));
    expect(error.code).toBe(code);
    expect(fakes.appointments).toHaveLength(0);
  });

  it('an inactive package cannot be booked', async () => {
    service.status = 'INACTIVE';
    const error = await reject(book());
    expect(error).toMatchObject({ statusCode: 400, code: 'SERVICE_UNAVAILABLE' });
    expect(fakes.appointments).toHaveLength(0);
  });

  it('an unknown package is a 404', async () => {
    const error = await reject(book({ serviceId: new mongoose.Types.ObjectId() }));
    expect(error).toMatchObject({ statusCode: 404, code: 'SERVICE_NOT_FOUND' });
  });

  it('a missing customer is a 404', async () => {
    const error = await reject(book({ customerId: new mongoose.Types.ObjectId() }));
    expect(error.code).toBe('CUSTOMER_NOT_FOUND');
    expect(fakes.appointments).toHaveLength(0);
  });
});

describe('one open service per customer per slot', () => {
  it('rejects a second service at the same slot, even for a different package', async () => {
    await book();
    const other = fakes.addService({ code: 'WASH', serviceName: 'Rửa xe' });
    const error = await reject(book({ serviceId: other._id }));
    expect(error).toMatchObject({ statusCode: 409, code: 'ALREADY_BOOKED_SERVICE' });
    expect(fakes.appointments).toHaveLength(1);
  });

  it('allows the same customer a service at a different slot', async () => {
    await book();
    const dto = await book({ scheduledAt: OTHER_SLOT });
    expect(dto.status).toBe('PENDING');
    expect(fakes.appointments).toHaveLength(2);
  });

  it('allows another customer the same slot', async () => {
    await book();
    const someone = fakes.addCustomer({ fullName: 'Khách khác' });
    const dto = await book({ customerId: someone._id });
    expect(dto.status).toBe('PENDING');
  });

  it('a cancelled service frees the slot for the same customer', async () => {
    const dto = await book();
    await cancelMyServiceAppointment({ customerId: customer._id, userId, id: dto.id, now: NOW });
    const again = await book();
    expect(again.status).toBe('PENDING');
  });
});

describe('shared capacity with test-drive', () => {
  const seedTestDrive = (who, at) => fakes.addAppointment({
    customer: who._id, car: fakes.addCar()._id, scheduledAt: at, status: 'PENDING',
  });

  it('counts test-drive visits toward the service capacity', async () => {
    fakes.capacity = 2;
    seedTestDrive(fakes.addCustomer(), SLOT);
    seedTestDrive(fakes.addCustomer(), SLOT);
    const error = await reject(book());
    expect(error).toMatchObject({ statusCode: 409, code: 'SLOT_FULL' });
    expect(fakes.appointments.filter((row) => row.type === 'SERVICE')).toHaveLength(0);
  });

  it('a multi-car test-drive visit counts as one', async () => {
    fakes.capacity = 2;
    const who = fakes.addCustomer();
    seedTestDrive(who, SLOT);
    seedTestDrive(who, SLOT);
    const dto = await book();
    expect(dto.status).toBe('PENDING');
  });

  it('a cancelled test-drive does not consume capacity', async () => {
    fakes.capacity = 1;
    const row = seedTestDrive(fakes.addCustomer(), SLOT);
    row.status = 'CANCELLED';
    const dto = await book();
    expect(dto.status).toBe('PENDING');
  });
});

describe('cancellation', () => {
  it('cancels an open appointment and records the reason', async () => {
    const dto = await book();
    const cancelled = await cancelMyServiceAppointment({
      customerId: customer._id, userId, id: dto.id, reason: 'Bận đột xuất', now: NOW,
    });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancellation).toMatchObject({ reason: 'Bận đột xuất' });
    expect(fakes.activityLogs.map((row) => row.eventType)).toContain('SERVICE_APPOINTMENT_CANCELLED');
  });

  it('flags a cancellation inside the 2 hour window as late', async () => {
    const dto = await book();
    const cancelled = await cancelMyServiceAppointment({
      customerId: customer._id, userId, id: dto.id, now: new Date(SLOT.getTime() - 30 * 60 * 1000),
    });
    expect(cancelled.cancellation.reason).toMatch(/^LATE:/);
  });

  it('refuses to cancel someone else\'s appointment', async () => {
    const dto = await book();
    const error = await reject(cancelMyServiceAppointment({
      customerId: fakes.addCustomer()._id, userId, id: dto.id, now: NOW,
    }));
    expect(error).toMatchObject({ statusCode: 404, code: 'SERVICE_APPOINTMENT_NOT_FOUND' });
  });

  it('refuses to cancel a completed appointment', async () => {
    const dto = await book();
    fakes.appointments[0].status = 'COMPLETED';
    const error = await reject(cancelMyServiceAppointment({
      customerId: customer._id, userId, id: dto.id, now: NOW,
    }));
    expect(error.code).toBe('SERVICE_APPOINTMENT_NOT_CANCELLABLE');
  });
});

describe('slot grid', () => {
  it('marks a full slot and the customer\'s own slot', async () => {
    fakes.capacity = 1;
    await book();
    const grid = await listServiceSlots({
      customerId: customer._id, from: '2026-11-10', to: '2026-11-10', now: NOW,
    });
    const day = grid.days.find((entry) => entry.date === '2026-11-10');
    const ten = day.slots.find((slot) => slot.start === '2026-11-10T10:00:00+07:00');
    const thirteen = day.slots.find((slot) => slot.start === '2026-11-10T13:00:00+07:00');
    expect(ten).toMatchObject({ available: false, reason: 'ALREADY_BOOKED' });
    expect(thirteen.available).toBe(true);

    const other = fakes.addCustomer();
    const otherGrid = await listServiceSlots({
      customerId: other._id, from: '2026-11-10', to: '2026-11-10', now: NOW,
    });
    const otherTen = otherGrid.days[0].slots.find((slot) => slot.start === '2026-11-10T10:00:00+07:00');
    expect(otherTen).toMatchObject({ available: false, reason: 'CAPACITY_FULL' });
  });

  it('rejects a range wider than 14 days', async () => {
    const error = await reject(listServiceSlots({
      customerId: customer._id, from: '2026-11-10', to: '2026-12-10', now: NOW,
    }));
    expect(error.code).toBe('VALIDATION_ERROR');
  });
});
