/**
 * @file appointment-race.test.js
 * @description Concurrency of createVisit with the real service and in-memory models.
 * A hook injects a second request at an exact moment (while the first one is inside its
 * transaction), or holds every request at the point "about to write my rows" (barrier).
 *
 * Two layers protect a booking, and each is tested on its own:
 *   - requests of the SAME customer queue up on the customer's document (write conflict → retry);
 *   - requests of DIFFERENT customers are separated by the unique indexes (E11000 → retry, and the
 *     retry sees the winner and answers with the business error).
 * Whatever the interleaving: never two open rows for one car and slot, never more visits than the
 * slot capacity, never more open visits than the limit, and a loser leaves NO row at all.
 *
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-210
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-213
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

// The car/seat indexes are tested on their own: duplicate codes are allowed here, otherwise two
// concurrent requests (which read the same next code) would collide on the code before the index.
beforeEach(() => { fakes.reset(); fakes.enableIndexes(); fakes.allowDuplicateCodes(); logSpy.mockClear(); });

const bookAs = (customer, carIds, scheduledAt = SLOT) => createVisit({
  userId: new mongoose.Types.ObjectId(), customerId: customer._id, carIds: carIds.map((c) => String(c._id)), scheduledAt, now: NOW,
});
const settle = (promises) => Promise.allSettled(promises);
const wins = (results) => results.filter((r) => r.status === 'fulfilled').length;
const codes = (results) => results.map((r) => r.reason?.code ?? 'OK');
const open = () => fakes.appointments.filter((r) => r.isActive && ['PENDING', 'CONFIRMED'].includes(r.status));

/** Every request pauses just before its FIRST row is written until `n` requests have got there (one-shot). */
const barrier = (n) => {
  let waiting = [];
  let released = false;
  fakes.hook = async ({ method, phase }) => {
    if (method !== 'create' || phase !== 'before' || released) return;
    await new Promise((resolve) => {
      waiting.push(resolve);
      if (waiting.length === n) { released = true; waiting.forEach((r) => r()); waiting = []; }
    });
  };
};

describe('same car, same slot (different customers: the unique index)', () => {
  it('B completes while A is inside its transaction: A is refused, B keeps the car, A leaves nothing', async () => {
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

    expect(fakes.appointments).toHaveLength(1); // not even a hidden row of A
    expect(String(open()[0].customer)).toBe(String(b._id));
    expect(logSpy).toHaveBeenCalledTimes(1); // only B's creation is audited
    expect(fakes.openTransactions).toBe(0);
  });

  it('both ready to write at the same moment: exactly one wins, the other gets the conflict', async () => {
    const [a, b] = [fakes.addCustomer(), fakes.addCustomer()];
    const car = fakes.addCar();
    barrier(2);
    const results = await settle([bookAs(a, [car]), bookAs(b, [car])]);
    expect(wins(results)).toBe(1);
    expect(codes(results).sort()).toEqual(['APPOINTMENT_CONFLICT', 'OK']);
    expect(open()).toHaveLength(1);
    expect(fakes.appointments).toHaveLength(1);
  });

  it('a three-car visit that loses leaves no stray row of its other cars (AC-10)', async () => {
    const [a, b] = [fakes.addCustomer(), fakes.addCustomer()];
    const cars = [fakes.addCar(), fakes.addCar(), fakes.addCar()];
    let fired = false;
    fakes.hook = async ({ method, phase }) => {
      if (method === 'create' && phase === 'before' && !fired) { fired = true; await bookAs(b, [cars[2]]); }
    };
    await expect(bookAs(a, cars)).rejects.toMatchObject({ code: 'APPOINTMENT_CONFLICT' });
    expect(fakes.appointments).toHaveLength(1);
    expect(open().map((r) => String(r.customer))).toEqual([String(b._id)]);
  });
});

describe('layers on their own', () => {
  const twoAtOnce = async () => {
    const [a, b] = [fakes.addCustomer(), fakes.addCustomer()];
    const car = fakes.addCar();
    barrier(2);
    return settle([bookAs(a, [car]), bookAs(b, [car])]);
  };

  it('without the unique indexes two customers CAN both take the car: why the migration must run (R1)', async () => {
    fakes.disableIndexes();
    expect(wins(await twoAtOnce())).toBe(2); // the rule check cannot see the other, uncommitted, transaction
  });

  it('only the car index enabled is enough to separate them', async () => {
    fakes.disableIndexes();
    fakes.enableIndexes('car');
    expect(wins(await twoAtOnce())).toBe(1);
  });

  it('the unique appointment code also separates two requests that start from the same code (an extra, incidental guard)', async () => {
    fakes.disableIndexes();
    fakes.state.codeUnique = true;
    expect(wins(await twoAtOnce())).toBe(1);
  });
});

describe('capacity (different customers: the seat index)', () => {
  it('three customers on different cars at once with capacity 2: two win, one is refused, no seat is shared', async () => {
    const people = [fakes.addCustomer(), fakes.addCustomer(), fakes.addCustomer()];
    const cars = people.map(() => fakes.addCar());
    barrier(3);
    const results = await settle(people.map((p, i) => bookAs(p, [cars[i]])));
    expect(wins(results)).toBe(2);
    expect(codes(results).filter((c) => c !== 'OK')).toEqual(['APPOINTMENT_CAPACITY_FULL']);
    const seats = open().map((r) => r.visitSeat).sort();
    expect(seats).toEqual([1, 2]);
  });

  it('capacity 1: two customers at once, one wins and the other is told the slot is full', async () => {
    fakes.capacity = 1;
    const people = [fakes.addCustomer(), fakes.addCustomer()];
    barrier(2);
    const results = await settle(people.map((p) => bookAs(p, [fakes.addCar()])));
    expect(codes(results).sort()).toEqual(['APPOINTMENT_CAPACITY_FULL', 'OK']);
    expect(open()).toHaveLength(1);
  });

  it('a late third customer is refused after two were accepted one by one', async () => {
    const people = [fakes.addCustomer(), fakes.addCustomer(), fakes.addCustomer()];
    await bookAs(people[0], [fakes.addCar()]);
    await bookAs(people[1], [fakes.addCar()]);
    await expect(bookAs(people[2], [fakes.addCar()])).rejects.toMatchObject({ code: 'APPOINTMENT_CAPACITY_FULL' });
    expect(open()).toHaveLength(2);
  });
});

describe('same customer (the customer document: write conflict, then retry)', () => {
  it('double submit of the same visit: one lượt is created, the other is refused as already booked (AC-13)', async () => {
    const a = fakes.addCustomer();
    const car = fakes.addCar();
    const results = await settle([bookAs(a, [car]), bookAs(a, [car])]);
    expect(wins(results)).toBe(1);
    expect(open()).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.statusCode).toBe(409);
    expect(fakes.openTransactions).toBe(0);
  });

  it('two new slots booked at once while one visit exists: never more than 2 open visits', async () => {
    const a = fakes.addCustomer();
    fakes.addAppointment({ customer: a._id, car: fakes.addCar()._id, scheduledAt: SLOTS[2], holdsCar: true, visitSeat: 1 });
    const results = await settle([bookAs(a, [fakes.addCar()], SLOTS[0]), bookAs(a, [fakes.addCar()], SLOTS[1])]);
    expect(new Set(open().map((r) => r.scheduledAt.getTime())).size).toBe(2);
    expect(wins(results)).toBe(1);
    expect(codes(results).filter((c) => c !== 'OK')).toEqual(['APPOINTMENT_LIMIT_REACHED']);
  });
});

describe('losers leave nothing behind', () => {
  it('a refused attempt does not block the car or the slot afterwards', async () => {
    const [a, b] = [fakes.addCustomer(), fakes.addCustomer()];
    const car = fakes.addCar();
    let fired = false;
    fakes.hook = async ({ method, phase }) => {
      if (method === 'create' && phase === 'before' && !fired) { fired = true; await bookAs(b, [car]); }
    };
    await settle([bookAs(a, [car])]);
    fakes.hook = null;
    const theirs = fakes.appointments.find((r) => String(r.customer) === String(b._id));
    theirs.status = 'CANCELLED'; // B cancels: the closing path releases the holds
    delete theirs.holdsCar;
    delete theirs.visitSeat;
    await expect(bookAs(a, [car])).resolves.toBeDefined();
    expect(open()).toHaveLength(1);
  });
});
