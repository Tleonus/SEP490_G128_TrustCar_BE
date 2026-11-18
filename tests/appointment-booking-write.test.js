/**
 * @file appointment-booking-write.test.js
 * @description createVisit write robustness inside the transaction: APT code retry, all-or-nothing
 * on any failure (no row left behind, not even a hidden one), the hold fields on the new rows.
 * Rule violations and the happy path are in appointment-booking.test.js; concurrency in
 * appointment-race.test.js.
 *
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-210
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-212
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-213
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { createVisit } from '../src/services/appointmentBookingService.js';
import { allocateCodes } from '../src/services/appointmentWrite.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';

const fakes = await setupAppointmentFakes();
const logSpy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const NOW = new Date('2026-11-08T00:00:00Z');
const SLOT = new Date('2026-11-10T03:00:00Z'); // 10:00 VN
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
const duplicateCode = () => Object.assign(new Error('E11000'), { code: 11000, keyPattern: { appointmentCode: 1 } });

describe('APT code (C15)', () => {
  it('retries when the APT code is taken, then succeeds', async () => {
    let failures = 0;
    fakes.hook = async ({ method, phase }) => {
      if (method === 'create' && phase === 'before' && failures < 2) { failures += 1; throw duplicateCode(); }
    };
    await expect(book({ carIds: ids(1) })).resolves.toBeDefined();
    expect(failures).toBe(2);
    expect(fakes.appointments).toHaveLength(1);
  });

  it('gives a generic 500 after too many duplicate codes and creates nothing', async () => {
    fakes.hook = async ({ method, phase }) => { if (method === 'create' && phase === 'before') throw duplicateCode(); };
    const error = await reject(book({ carIds: ids(1) }));
    expect(error).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
    expect(fakes.appointments).toHaveLength(0);
  });

  it('gives the rows of one visit consecutive, distinct codes (generateAppointmentCode reads outside the transaction)', async () => {
    await book({ carIds: ids(3) });
    expect(fakes.appointments.map((r) => r.appointmentCode)).toEqual(['APT-0001', 'APT-0002', 'APT-0003']);
  });

  it('keeps counting past 9999 with the 8-digit format', async () => {
    fakes.addAppointment({ appointmentCode: 'APT-9999', customer: fakes.addCustomer()._id, car: fakes.addCar()._id, scheduledAt: new Date('2026-11-12T03:00:00Z') });
    expect(await allocateCodes(3)).toEqual(['APT-00010000', 'APT-00010001', 'APT-00010002']);
  });
});

describe('all or nothing (INV-4)', () => {
  it('rolls back the rows already written when a later write fails: no stray row, not even a hidden one', async () => {
    let creates = 0;
    fakes.hook = async ({ method, phase }) => {
      if (method === 'create' && phase === 'before') { creates += 1; if (creates === 2) throw new Error('disk full'); }
    };
    const error = await reject(book());
    expect(error.message).toBe('disk full');
    expect(fakes.appointments).toHaveLength(0);
    expect(fakes.openTransactions).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('writes nothing when a read inside the transaction fails', async () => {
    fakes.hook = async ({ method, phase, model }) => {
      if (model === 'Appointment' && method === 'find' && phase === 'before') throw new Error('db down');
    };
    expect((await reject(book())).message).toBe('db down');
    expect(fakes.appointments).toHaveLength(0);
    expect(fakes.openTransactions).toBe(0);
  });

  it('an unknown customer is refused with 404 and nothing is written', async () => {
    const error = await reject(book({ customerId: new mongoose.Types.ObjectId() }));
    expect(error).toMatchObject({ statusCode: 404, code: 'CUSTOMER_NOT_FOUND' });
    expect(fakes.appointments).toHaveLength(0);
  });

  it('a failed booking can be repeated: nothing it left behind blocks the retry', async () => {
    let fail = true;
    fakes.hook = async ({ method, phase }) => { if (fail && method === 'create' && phase === 'before') throw new Error('boom'); };
    await reject(book());
    fail = false;
    await expect(book()).resolves.toBeDefined();
    expect(fakes.appointments).toHaveLength(2);
  });
});

describe('hold fields on the new rows (REQ-212, AC-14)', () => {
  const holders = () => fakes.appointments.filter((r) => r.holdsCar === true);
  const seats = () => fakes.appointments.filter((r) => typeof r.visitSeat === 'number');

  it('every row of the visit holds its car; exactly one row (the lowest code) holds the seat', async () => {
    await book({ carIds: ids(3) });
    expect(holders()).toHaveLength(3);
    expect(seats()).toHaveLength(1);
    expect(seats()[0]).toMatchObject({ appointmentCode: 'APT-0001', visitSeat: 1 });
  });

  it('visits at the same slot get the smallest free seat', async () => {
    fakes.capacity = 3;
    await book({ carIds: ids(1) });
    const second = fakes.addCustomer();
    await createVisit({ userId, customerId: second._id, carIds: [String(fakes.addCar()._id)], scheduledAt: SLOT, now: NOW });
    expect(seats().map((r) => r.visitSeat).sort()).toEqual([1, 2]);
  });

  it('a seat freed by a cancelled visit is handed out again', async () => {
    fakes.capacity = 3;
    await book({ carIds: ids(1) });
    const second = fakes.addCustomer();
    await createVisit({ userId, customerId: second._id, carIds: [String(fakes.addCar()._id)], scheduledAt: SLOT, now: NOW });
    const first = fakes.appointments[0];
    first.status = 'CANCELLED';
    delete first.holdsCar;
    delete first.visitSeat; // what every closing path does (REQ-214)
    const third = fakes.addCustomer();
    await createVisit({ userId, customerId: third._id, carIds: [String(fakes.addCar()._id)], scheduledAt: SLOT, now: NOW });
    expect(seats().map((r) => r.visitSeat).sort()).toEqual([1, 2]);
  });

  it('an old KAN-28 row holding slotSeat 1 keeps seat 1: the new visit gets seat 2 (AC-19)', async () => {
    fakes.capacity = 3;
    fakes.addAppointment({ customer: fakes.addCustomer()._id, car: fakes.addCar()._id, scheduledAt: SLOT, slotSeat: 1 });
    await book({ carIds: ids(1) });
    const mine = fakes.appointments.find((r) => String(r.customer) === String(customer._id));
    expect(mine.visitSeat).toBe(2);
  });

  it('the staff booking path writes the same hold fields', async () => {
    const { createVisitForCustomer } = await import('../src/services/appointmentStaffBookingService.js');
    const staff = new mongoose.Types.ObjectId();
    fakes.addUser({ _id: staff });
    const account = new mongoose.Types.ObjectId();
    fakes.state.users.push({ _id: account, customer: customer._id, roleName: 'CUSTOMER', isActive: true, fullName: 'Khách' });
    await createVisitForCustomer({ userId: staff, customerId: customer._id, carIds: ids(2), scheduledAt: SLOT, now: NOW });
    expect(holders()).toHaveLength(2);
    expect(seats()).toHaveLength(1);
    expect(fakes.appointments.every((r) => r.status === 'CONFIRMED')).toBe(true);
  });
});
