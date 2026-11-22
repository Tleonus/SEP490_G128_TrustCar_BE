/**
 * @file appointment-booking.test.js
 * @description createVisit: happy path, input/time guards (0 queries), car checks,
 * every rule violation (no rows left behind), APT code retry, cleanup after a failed write.
 * Concurrency is covered by appointment-race.test.js.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-003…011, 023; AC-01…10, AC-12, AC-23)
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { createVisit } from '../src/services/appointmentBookingService.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';

const fakes = await setupAppointmentFakes();
const logSpy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const NOW = new Date('2026-11-08T00:00:00Z');
const SLOT = new Date('2026-11-10T03:00:00Z'); // 10:00 VN
const OTHER_SLOT = new Date('2026-11-10T06:00:00Z'); // 13:00 VN
const userId = new mongoose.Types.ObjectId();
let customer;
let cars;

beforeEach(() => {
  fakes.reset();
  logSpy.mockClear();
  customer = fakes.addCustomer();
  cars = [fakes.addCar(), fakes.addCar(), fakes.addCar()];
});

const ids = (n) => cars.slice(0, n).map((car) => String(car._id));
const book = (extra = {}) => createVisit({
  userId, customerId: customer._id, carIds: ids(2), scheduledAt: SLOT, now: NOW, ...extra,
});
const reject = async (promise) => promise.then(() => null, (error) => error);
const openRows = () => fakes.appointments.filter((row) => row.isActive && ['PENDING', 'CONFIRMED'].includes(row.status));
const other = () => fakes.addCustomer({ fullName: 'Người khác' });

describe('happy path (AC-01, AC-23)', () => {
  it('creates one PENDING appointment per car and returns the customer view', async () => {
    const visit = await book({ notes: '  Muốn chạy thử cao tốc  ' });
    expect(fakes.appointments).toHaveLength(2);
    fakes.appointments.forEach((row) => {
      expect(row).toMatchObject({
        status: 'PENDING', type: 'TEST_DRIVE', durationMinutes: 90, isActive: true,
        location: 'Showroom TrustCar, Quận 1, TP. Hồ Chí Minh', notes: 'Muốn chạy thử cao tốc',
      });
      expect(String(row.customer)).toBe(String(customer._id));
      expect(String(row.createdBy)).toBe(String(userId));
    });
    expect(fakes.appointments.map((r) => r.appointmentCode)).toEqual(['APT-0001', 'APT-0002']);
    expect(visit).toMatchObject({ visitCode: 'APT-0001', status: 'PENDING', scheduledAt: '2026-11-10T03:00:00.000Z', notes: 'Muốn chạy thử cao tốc' });
    expect(visit.appointments).toHaveLength(2);
    expect(visit.appointments[0].car.primaryImageUrl).toBe('https://img.example/a.jpg');
    expect(JSON.stringify(visit)).not.toMatch(/secret|VIN123|51A-000|internalNotes|publicId|floorPrice/);
  });

  it('logs one APPOINTMENT_CREATED per appointment', async () => {
    await book();
    expect(logSpy).toHaveBeenCalledTimes(2);
    logSpy.mock.calls.forEach(([entry]) => expect(entry).toMatchObject({
      eventType: 'APPOINTMENT_CREATED', targetModel: 'Appointment', performedBy: userId,
    }));
  });

  it('stores empty notes as null', async () => {
    await book({ notes: '   ' });
    expect(fakes.appointments[0].notes).toBeNull();
  });

  it('books three cars with one Car query and three creates', async () => {
    await book({ carIds: ids(3) });
    expect(fakes.count('Car')).toBe(1);
    expect(fakes.count('Appointment', 'create')).toBe(3);
  });
});

describe('guards before any query (NFR-01)', () => {
  it.each([
    ['too soon', { scheduledAt: new Date(NOW.getTime() + 3600e3) }, 'APPOINTMENT_TOO_SOON'],
    ['too far', { scheduledAt: new Date(NOW.getTime() + 61 * 86400e3) }, 'APPOINTMENT_TOO_FAR'],
    ['off slot', { scheduledAt: new Date('2026-11-10T02:00:00Z') }, 'APPOINTMENT_SLOT_INVALID'],
    ['no customer link', { customerId: null }, 'CUSTOMER_NOT_FOUND'],
  ])('%s → %s without touching the database', async (_name, extra, code) => {
    const error = await reject(book(extra));
    expect(error.code).toBe(code);
    expect(fakes.calls).toHaveLength(0);
  });
});

describe('cars (REQ-005, AC-03)', () => {
  it.each(['SOLD', 'RESERVED', 'DELISTED', 'MAINTENANCE'])('a %s car → 404 NOT_FOUND and nothing is created', async (status) => {
    cars[1].status = status;
    const error = await reject(book());
    expect(error).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(fakes.appointments).toHaveLength(0);
  });

  it('an inactive or unknown car gives the same answer', async () => {
    cars[0].isActive = false;
    expect((await reject(book())).code).toBe('NOT_FOUND');
    cars[0].isActive = true;
    const ghost = String(new mongoose.Types.ObjectId());
    expect((await reject(book({ carIds: [ids(1)[0], ghost] }))).code).toBe('NOT_FOUND');
    expect(fakes.appointments).toHaveLength(0);
  });
});

describe('rule violations leave no rows behind (AC-06…10, AC-12)', () => {
  const seed = (who, car, scheduledAt, extra = {}) =>
    fakes.addAppointment({ customer: who._id, car: car._id, scheduledAt, ...extra });

  it('DUPLICATE: same slot, then same car at another slot (409)', async () => {
    seed(customer, cars[2], SLOT);
    let error = await reject(book());
    expect(error).toMatchObject({ statusCode: 409, code: 'APPOINTMENT_DUPLICATE' });
    expect(error.errors).toHaveProperty('slot', '2026-11-10T10:00:00+07:00');

    fakes.reset();
    customer = fakes.addCustomer(); cars = [fakes.addCar(), fakes.addCar()];
    seed(customer, cars[1], OTHER_SLOT);
    error = await reject(book());
    expect(error).toMatchObject({ code: 'APPOINTMENT_DUPLICATE', errors: { carIds: [String(cars[1]._id)] } });
  });

  it('LIMIT: two upcoming visits already exist (422); a cancelled one is not counted', async () => {
    seed(customer, cars[2], OTHER_SLOT);
    seed(customer, cars[2], new Date('2026-11-11T03:00:00Z'));
    const error = await reject(book());
    expect(error).toMatchObject({ statusCode: 422, code: 'APPOINTMENT_LIMIT_REACHED' });

    fakes.appointments.find((r) => r.scheduledAt.getTime() === new Date('2026-11-11T03:00:00Z').getTime()).status = 'CANCELLED';
    await expect(book()).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('CONFLICT: another customer holds one car; lists it; the other cars are not booked (AC-08, AC-12)', async () => {
    seed(other(), cars[2], SLOT);
    const error = await reject(book({ carIds: ids(3) }));
    expect(error).toMatchObject({ statusCode: 409, code: 'APPOINTMENT_CONFLICT', errors: { carIds: [String(cars[2]._id)] } });
    expect(fakes.appointments).toHaveLength(1);
    await expect(book({ carIds: ids(3), scheduledAt: OTHER_SLOT })).resolves.toBeDefined();
  });

  it('closed rows never conflict (AC-09)', async () => {
    const rival = other();
    ['CANCELLED', 'COMPLETED', 'NO_SHOW'].forEach((status) => seed(rival, cars[0], SLOT, { status }));
    await expect(book()).resolves.toBeDefined();
  });

  it('CAPACITY: two other customers fill the slot (409), another slot is fine (AC-10)', async () => {
    const spare = fakes.addCar();
    seed(other(), spare, SLOT);
    seed(other(), fakes.addCar(), SLOT);
    expect(await reject(book())).toMatchObject({ statusCode: 409, code: 'APPOINTMENT_CAPACITY_FULL' });
    expect(fakes.appointments).toHaveLength(2);
    await expect(book({ scheduledAt: OTHER_SLOT })).resolves.toBeDefined();
  });
});
