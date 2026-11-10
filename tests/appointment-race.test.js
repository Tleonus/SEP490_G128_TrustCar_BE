/**
 * @file appointment-race.test.js
 * @description Concurrency of createVisit with the real service and in-memory models.
 * A hook injects a second request at an exact moment, or holds every request at the
 * point "my rows are written, nobody has re-checked yet" (barrier).
 *
 * Whatever the interleaving: never two open rows for one car and slot, never more
 * customers than the slot capacity, never more open visits than the limit; losers
 * leave only hidden rows and no audit log (REQ-012, AC-11, AC-12).
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-012, INV-2/3/4, C9)
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { createVisit } from '../src/services/appointmentBookingService.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';

const fakes = await setupAppointmentFakes();
const logSpy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const NOW = new Date('2026-11-08T00:00:00Z');
const SLOT = new Date('2026-11-10T03:00:00Z');
const SLOTS = [SLOT, new Date('2026-11-10T06:00:00Z'), new Date('2026-11-11T03:00:00Z')];

beforeEach(() => { fakes.reset(); logSpy.mockClear(); });

const bookAs = (customer, carIds, scheduledAt = SLOT) => createVisit({
  userId: new mongoose.Types.ObjectId(), customerId: customer._id, carIds: carIds.map((c) => String(c._id)), scheduledAt, now: NOW,
});
const settle = (promises) => Promise.allSettled(promises);
const wins = (results) => results.filter((r) => r.status === 'fulfilled').length;
const open = () => fakes.appointments.filter((r) => r.isActive && ['PENDING', 'CONFIRMED'].includes(r.status));

/** Every request pauses right after its rows are written until `n` requests have written. */
const barrier = (n) => {
  let waiting = [];
  fakes.hook = async ({ method, phase }) => {
    if (method !== 'create' || phase !== 'after') return;
    await new Promise((resolve) => {
      waiting.push(resolve);
      if (waiting.length === n) { waiting.forEach((r) => r()); waiting = []; }
    });
  };
};

describe('same car, same slot', () => {
  it('B completes between A\'s check and A\'s write: A loses, B keeps the car, A leaves hidden rows only', async () => {
    const [a, b] = [fakes.addCustomer(), fakes.addCustomer()];
    const car = fakes.addCar();
    let fired = false;
    fakes.hook = async ({ method, phase }) => {
      if (method === 'create' && phase === 'before' && !fired) {
        fired = true;
        await bookAs(b, [car]); // B runs completely while A is between its check and its write
      }
    };
    await expect(bookAs(a, [car])).rejects.toMatchObject({ statusCode: 409, code: 'APPOINTMENT_CONFLICT', errors: { carIds: [String(car._id)] } });

    expect(open()).toHaveLength(1);
    expect(String(open()[0].customer)).toBe(String(b._id));
    const lost = fakes.appointments.filter((r) => String(r.customer) === String(a._id));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ isActive: false, status: 'CANCELLED', cancellationReason: 'RACE_LOST' });
    expect(logSpy).toHaveBeenCalledTimes(1); // only B's creation is audited, the loser never was visible
  });

  it('both wrote before either re-checked: both see the other and both lose, nobody double-books', async () => {
    const [a, b] = [fakes.addCustomer(), fakes.addCustomer()];
    const car = fakes.addCar();
    barrier(2);
    const results = await settle([bookAs(a, [car]), bookAs(b, [car])]);
    expect(fakes.appointments).toHaveLength(2); // both really wrote
    expect(results.map((r) => r.reason?.code)).toEqual(['APPOINTMENT_CONFLICT', 'APPOINTMENT_CONFLICT']);
    expect(open()).toHaveLength(0);
    expect(fakes.appointments.every((r) => r.cancellationReason === 'RACE_LOST' && r.isActive === false)).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('a three-car visit that loses leaves no stray row of its other cars (AC-12)', async () => {
    const [a, b] = [fakes.addCustomer(), fakes.addCustomer()];
    const cars = [fakes.addCar(), fakes.addCar(), fakes.addCar()];
    let fired = false;
    fakes.hook = async ({ method, phase }) => {
      if (method === 'create' && phase === 'before' && !fired) {
        fired = true;
        await bookAs(b, [cars[2]]);
      }
    };
    await expect(bookAs(a, cars)).rejects.toMatchObject({ code: 'APPOINTMENT_CONFLICT' });
    expect(open().map((r) => String(r.customer))).toEqual([String(b._id)]);
    expect(fakes.appointments.filter((r) => String(r.customer) === String(a._id))).toHaveLength(3);
  });
});

describe('capacity', () => {
  it('three customers on different cars at once: the slot never holds more than 2 customers', async () => {
    const people = [fakes.addCustomer(), fakes.addCustomer(), fakes.addCustomer()];
    const cars = people.map(() => fakes.addCar());
    barrier(3);
    const results = await settle(people.map((p, i) => bookAs(p, [cars[i]])));
    expect(new Set(open().map((r) => String(r.customer))).size).toBeLessThanOrEqual(2);
    expect(wins(results)).toBeLessThanOrEqual(2);
  });

  it('a late third customer is refused after two were accepted one by one', async () => {
    const people = [fakes.addCustomer(), fakes.addCustomer(), fakes.addCustomer()];
    await bookAs(people[0], [fakes.addCar()]);
    await bookAs(people[1], [fakes.addCar()]);
    await expect(bookAs(people[2], [fakes.addCar()])).rejects.toMatchObject({ code: 'APPOINTMENT_CAPACITY_FULL' });
    expect(open()).toHaveLength(2);
  });
});

describe('per-customer limits', () => {
  it('double submit of the same visit: at most one survives', async () => {
    const a = fakes.addCustomer();
    const car = fakes.addCar();
    barrier(2);
    const results = await settle([bookAs(a, [car]), bookAs(a, [car])]);
    expect(wins(results)).toBeLessThanOrEqual(1);
    expect(open().length).toBeLessThanOrEqual(1);
  });

  it('two new slots booked at once while one visit exists: never more than 2 open visits', async () => {
    const a = fakes.addCustomer();
    fakes.addAppointment({ customer: a._id, car: fakes.addCar()._id, scheduledAt: SLOTS[2] });
    barrier(2);
    const results = await settle([bookAs(a, [fakes.addCar()], SLOTS[0]), bookAs(a, [fakes.addCar()], SLOTS[1])]);
    const visits = new Set(open().map((r) => r.scheduledAt.getTime()));
    expect(visits.size).toBeLessThanOrEqual(2);
    expect(wins(results)).toBeLessThanOrEqual(1);
  });
});

describe('losers are invisible', () => {
  it('a hidden RACE_LOST row does not block the car or the slot afterwards', async () => {
    const [a, b] = [fakes.addCustomer(), fakes.addCustomer()];
    const car = fakes.addCar();
    let fired = false;
    fakes.hook = async ({ method, phase }) => {
      if (method === 'create' && phase === 'before' && !fired) { fired = true; await bookAs(b, [car]); }
    };
    await settle([bookAs(a, [car])]);
    fakes.hook = null;
    fakes.appointments.find((r) => String(r.customer) === String(b._id)).status = 'CANCELLED'; // B cancels
    await expect(bookAs(a, [car])).resolves.toBeDefined();
    expect(open()).toHaveLength(1);
  });
});
