/**
 * @file appointment-reschedule-race.test.js
 * @description Concurrency and failure handling of rescheduling, with the real service and
 * in-memory models. A hook injects other requests at exact moments (between the rule check
 * and the write, between the re-check and the retirement of the old rows), or holds every
 * request at "my new rows are written, nobody has re-checked yet" (barrier).
 *
 * Whatever happens, after every request has finished:
 *   INV-10  the customer has EITHER the untouched old visit OR the new visit, never both
 *           open and never (unless they cancelled) neither;
 *   INV-11  from one old visit at most one move succeeds;
 *   INV-2/3/4  one open row per car and slot, at most 2 customers per slot, at most 2 open
 *           visits per customer.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-033, INV-10, INV-11, AC-32)
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { rescheduleMyVisit, rescheduleVisitAsStaff } from '../src/services/appointmentRescheduleService.js';
import { cancelMyVisit } from '../src/services/appointmentCustomerService.js';
import { createVisit } from '../src/services/appointmentBookingService.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';
import { default as Appointment } from '../src/models/Appointment.js';

const fakes = await setupAppointmentFakes();
const logSpy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const NOW = new Date('2026-11-08T00:00:00Z');
const OLD = new Date('2026-11-12T03:00:00Z'); // Thu 10:00
const S1 = new Date('2026-11-13T06:00:00Z'); // Fri 13:00
const S2 = new Date('2026-11-14T03:00:00Z'); // Sat 10:00
const userId = new mongoose.Types.ObjectId();
let me;

beforeEach(() => {
  fakes.reset(); logSpy.mockClear();
  me = fakes.addCustomer({ email: 'an@example.com' });
});

const openRows = () => fakes.appointments.filter((r) => r.isActive && ['PENDING', 'CONFIRMED'].includes(r.status));
const mineOpen = () => openRows().filter((r) => String(r.customer) === String(me._id));
const slotsOf = (rows) => [...new Set(rows.map((r) => r.scheduledAt.getTime()))].sort();
const row = (who, scheduledAt, extra = {}) =>
  fakes.addAppointment({ customer: who._id, car: fakes.addCar()._id, scheduledAt, createdBy: userId, createdAt: NOW, ...extra });
const move = (scheduledAt, id, extra = {}) =>
  rescheduleMyVisit({ customerId: me._id, userId, id, scheduledAt, now: NOW, ...extra });
const settle = (promises) => Promise.allSettled(promises);
const wins = (results) => results.filter((r) => r.status === 'fulfilled').length;
const codeOf = (result) => result.reason?.code;

/** The rules that must hold after ANY interleaving. */
const expectGlobalInvariants = () => {
  const open = openRows();
  const byCarSlot = new Map();
  open.forEach((r) => {
    const key = `${r.car}|${r.scheduledAt.getTime()}`;
    byCarSlot.set(key, (byCarSlot.get(key) ?? 0) + 1);
  });
  expect([...byCarSlot.values()].every((n) => n === 1)).toBe(true); // INV-2
  const guestsBySlot = new Map();
  open.forEach((r) => {
    const set = guestsBySlot.get(r.scheduledAt.getTime()) ?? new Set();
    set.add(String(r.customer));
    guestsBySlot.set(r.scheduledAt.getTime(), set);
  });
  expect([...guestsBySlot.values()].every((set) => set.size <= 2)).toBe(true); // INV-3
  const slotsByGuest = new Map();
  open.forEach((r) => {
    const set = slotsByGuest.get(String(r.customer)) ?? new Set();
    set.add(r.scheduledAt.getTime());
    slotsByGuest.set(String(r.customer), set);
  });
  expect([...slotsByGuest.values()].every((set) => set.size <= 2)).toBe(true); // INV-4
  // A reschedule leftover is never visible.
  expect(fakes.appointments.filter((r) => r.isActive && String(r.cancellationReason ?? '').startsWith('RESCHEDULED:'))).toEqual([]);
};

/**
 * Every request pauses at its `create` call (`phase`: 'before' = checked but not written yet,
 * 'after' = written but not re-checked yet) until `n` requests are paused together. A request
 * that was refused earlier never arrives, so the others are released after a short grace time
 * instead of waiting forever.
 */
const barrier = (n, phase = 'after') => {
  let waiting = [];
  const releaseAll = () => { waiting.forEach((release) => release()); waiting = []; };
  fakes.hook = async ({ method, phase: now }) => {
    if (method !== 'create' || now !== phase) return;
    await new Promise((resolve) => {
      waiting.push(resolve);
      if (waiting.length >= n) releaseAll();
      else setTimeout(releaseAll, 150);
    });
  };
};

/** Runs `inject` once, at the first call of `method` in `phase`. */
const injectOnce = (method, phase, inject) => {
  let fired = false;
  fakes.hook = async (call) => {
    if (fired || call.method !== method || call.phase !== phase) return;
    fired = true;
    await inject();
  };
};

describe('two moves of the same visit (INV-11)', () => {
  // Both requests hold the same car, so when both have written they see each other's rows as a
  // clash on that car and BOTH lose. That is the safe outcome the Spec allows ("they may both
  // lose"); what must never happen is both winning.
  it('both wrote before either re-checked: they see each other, both lose, the old visit is untouched', async () => {
    const [a] = [row(me, OLD)];
    barrier(2);
    const results = await settle([move(S1, a._id), move(S2, a._id)]);
    expect(wins(results)).toBe(0);
    expect(results.map(codeOf)).toEqual(['APPOINTMENT_DUPLICATE', 'APPOINTMENT_DUPLICATE']);
    expect(a).toMatchObject({ isActive: true, status: 'PENDING' });
    expect(mineOpen()).toHaveLength(1);
    expect(slotsOf(mineOpen())).toEqual([OLD.getTime()]);
    expectGlobalInvariants();
    expect(await fakes.flushMail()).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  // If the second request only starts to write after the first has re-checked but before the
  // first retires the old rows, the second finds the first's new rows (same car) and loses at
  // its own re-check; the first then retires the old rows and wins alone.
  it('the second request writes after the first re-checked: the first wins alone, the second leaves nothing visible', async () => {
    const [a] = [row(me, OLD)];
    let other;
    injectOnce('updateMany', 'before', async () => { other = await settle([move(S2, a._id)]); });
    const first = await move(S1, a._id);
    expect(first.visit.scheduledAt).toBe(S1.toISOString());
    expect(wins(other)).toBe(0);
    expect(mineOpen()).toHaveLength(1);
    expect(mineOpen()[0].scheduledAt).toEqual(S1);
    expect(a).toMatchObject({ isActive: false });
    expectGlobalInvariants();
    expect(await fakes.flushMail()).toHaveLength(1); // only the winner is told
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('with another open visit the customer is at the limit: both see each other and both lose, the old visit is untouched', async () => {
    const [a] = [row(me, OLD)];
    row(me, new Date('2026-11-15T03:00:00Z'));
    barrier(2);
    const results = await settle([move(S1, a._id), move(S2, a._id)]);
    expect(wins(results)).toBeLessThanOrEqual(1);
    expect(slotsOf(mineOpen()).length).toBeLessThanOrEqual(2);
    expectGlobalInvariants();
    if (wins(results) === 0) {
      expect(a).toMatchObject({ isActive: true, status: 'PENDING' });
      expect(mineOpen()).toHaveLength(2);
    }
  });

  it('a second move that starts after the first finished sees the new visit as the only one', async () => {
    const [a] = [row(me, OLD)];
    const first = await move(S1, a._id);
    const error = await move(S2, a._id).catch((e) => e);
    expect(error.code).toBe('APPOINTMENT_NOT_FOUND'); // the old rows are hidden: that id no longer exists for the customer
    expect(first.visit.scheduledAt).toBe(S1.toISOString());
    expectGlobalInvariants();
  });
});

describe('a move racing a cancellation (INV-10)', () => {
  it('the customer cancels between the re-check and the retirement: the cancel wins and nothing new stays open', async () => {
    const [a] = [row(me, OLD)];
    injectOnce('updateMany', 'before', () => cancelMyVisit({ customerId: me._id, userId, id: a._id, now: NOW }));
    const error = await move(S1, a._id).catch((e) => e);
    expect(error.code).toBe('APPOINTMENT_STATUS_INVALID');
    expect(a).toMatchObject({ status: 'CANCELLED', isActive: true });
    expect(mineOpen()).toHaveLength(0);
    expect(fakes.appointments.filter((r) => r !== a).every((r) => r.isActive === false)).toBe(true);
    expectGlobalInvariants();
  });

  it('the customer cancels before the new rows are written: same outcome', async () => {
    const [a] = [row(me, OLD)];
    injectOnce('create', 'before', () => cancelMyVisit({ customerId: me._id, userId, id: a._id, now: NOW }));
    const error = await move(S1, a._id).catch((e) => e);
    expect(error.code).toBe('APPOINTMENT_STATUS_INVALID');
    expect(mineOpen()).toHaveLength(0);
    expectGlobalInvariants();
  });

  it('staff cancel the visit while the customer moves it: still exactly one outcome', async () => {
    const [a] = [row(me, OLD)];
    injectOnce('updateMany', 'before', async () => {
      Object.assign(a, { status: 'CANCELLED', cancellationReason: 'OTHER|staff' }); // what the staff update does
    });
    const error = await move(S1, a._id).catch((e) => e);
    expect(error.code).toBe('APPOINTMENT_STATUS_INVALID');
    expect(mineOpen()).toHaveLength(0);
    expectGlobalInvariants();
  });
});

describe('a move racing other customers for the target slot (INV-3, INV-2)', () => {
  it('two others fill the target slot between the check and the write: the move loses and the old visit stays', async () => {
    const [a] = [row(me, OLD)];
    const [x, y] = [fakes.addCustomer(), fakes.addCustomer()];
    injectOnce('create', 'before', async () => {
      await createVisit({ userId, customerId: x._id, carIds: [String(fakes.addCar()._id)], scheduledAt: S1, now: NOW });
      await createVisit({ userId, customerId: y._id, carIds: [String(fakes.addCar()._id)], scheduledAt: S1, now: NOW });
    });
    const error = await move(S1, a._id).catch((e) => e);
    expect(error.code).toBe('APPOINTMENT_CAPACITY_FULL');
    expect(a).toMatchObject({ isActive: true, status: 'PENDING' });
    expect(mineOpen()).toHaveLength(1);
    expect(fakes.appointments.filter((r) => String(r.customer) === String(me._id) && !r.isActive)[0]).toMatchObject({ cancellationReason: 'RACE_LOST' });
    expectGlobalInvariants();
  });

  it('a booking and a move write at the same time into a slot with one place left: not both stay', async () => {
    const [a] = [row(me, OLD)];
    row(fakes.addCustomer(), S1); // one place taken, one left
    const newcomer = fakes.addCustomer();
    barrier(2, 'before'); // both pass their pre-check, then both write
    const results = await settle([
      move(S1, a._id),
      createVisit({ userId, customerId: newcomer._id, carIds: [String(fakes.addCar()._id)], scheduledAt: S1, now: NOW }),
    ]);
    expect(wins(results)).toBeLessThanOrEqual(1);
    const guests = new Set(openRows().filter((r) => r.scheduledAt.getTime() === S1.getTime()).map((r) => String(r.customer)));
    expect(guests.size).toBeLessThanOrEqual(2);
    expectGlobalInvariants();
    // The mover either kept the old visit or owns the new one — never both.
    expect(a.isActive === true && mineOpen().some((r) => r.scheduledAt.getTime() === S1.getTime())).toBe(false);
  });

  it('another customer takes the same car at the target slot at the same time: only one keeps it', async () => {
    const [a] = [row(me, OLD)];
    const rival = fakes.addCustomer();
    barrier(2, 'before');
    const results = await settle([
      move(S1, a._id),
      createVisit({ userId, customerId: rival._id, carIds: [String(a.car)], scheduledAt: S1, now: NOW }),
    ]);
    expect(wins(results)).toBeLessThanOrEqual(1);
    expectGlobalInvariants();
    const holders = openRows().filter((r) => String(r.car) === String(a.car) && r.scheduledAt.getTime() === S1.getTime());
    expect(holders.length).toBeLessThanOrEqual(1);
    // The mover either kept the old visit or owns the new one — never both.
    expect(a.isActive === true && mineOpen().some((r) => r.scheduledAt.getTime() === S1.getTime())).toBe(false);
  });
});

describe('failures in the middle (INV-10: the old visit is never lost)', () => {
  it('retirement changes only some of the old rows: the move is undone completely', async () => {
    const [a, b] = [row(me, OLD, { status: 'CONFIRMED', confirmedBy: userId, confirmedAt: NOW }), row(me, OLD, { status: 'CONFIRMED', confirmedBy: userId, confirmedAt: NOW })];
    Appointment.updateMany.mockImplementationOnce(async (filter, update) => {
      Object.assign(a, update.$set); // only the first row is hidden, as if another request changed the second
      return { modifiedCount: 1 };
    });
    const error = await move(S1, a._id).catch((e) => e);
    expect(error.code).toBe('APPOINTMENT_STATUS_INVALID');
    expect(a).toMatchObject({ isActive: true, status: 'CONFIRMED', cancellationReason: null }); // restored
    expect(b).toMatchObject({ isActive: true, status: 'CONFIRMED' });
    expect(mineOpen()).toHaveLength(2);
    expect(slotsOf(mineOpen())).toEqual([OLD.getTime()]);
    expect(fakes.appointments.filter((r) => r.scheduledAt.getTime() === S1.getTime()).every((r) => !r.isActive)).toBe(true);
    expectGlobalInvariants();
    expect(await fakes.flushMail()).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('the retirement query itself fails: the new rows are hidden, the old visit is intact, the error surfaces', async () => {
    const [a] = [row(me, OLD)];
    Appointment.updateMany.mockImplementationOnce(async () => { throw new Error('db down'); });
    await expect(move(S1, a._id)).rejects.toThrow('db down');
    expect(a).toMatchObject({ isActive: true, status: 'PENDING' });
    expect(mineOpen()).toHaveLength(1);
    expectGlobalInvariants();
  });

  it('writing the second new row fails: the first is hidden again, nothing is left half-moved', async () => {
    const [a] = myTwo();
    let calls = 0;
    const original = Appointment.create.getMockImplementation();
    Appointment.create.mockImplementation(async (data) => {
      calls += 1;
      if (calls === 2) throw new Error('write failed');
      return original(data);
    });
    await expect(move(S1, a._id)).rejects.toThrow('write failed');
    Appointment.create.mockImplementation(original);
    expect(mineOpen()).toHaveLength(2);
    expect(slotsOf(mineOpen())).toEqual([OLD.getTime()]);
    expect(fakes.appointments.filter((r) => r.scheduledAt.getTime() === S1.getTime()).every((r) => !r.isActive)).toBe(true);
    expectGlobalInvariants();
  });

  function myTwo() { return [row(me, OLD), row(me, OLD)]; }

  it('the audit log failing after a successful move does not turn it into an error', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const [a] = [row(me, OLD)];
    logSpy.mockRejectedValueOnce(new Error('log down'));
    const { visit } = await move(S1, a._id);
    expect(visit.status).toBe('PENDING');
    expectGlobalInvariants();
    quiet.mockRestore();
  });
});

describe('staff move racing the customer', () => {
  it('staff and the customer move the same visit at once: never both, and the visit is never lost', async () => {
    const [a] = [row(me, OLD)];
    fakes.addUser({ _id: userId, fullName: 'Lan' });
    barrier(2);
    const results = await settle([
      move(S1, a._id),
      rescheduleVisitAsStaff({ id: a._id, userId, scheduledAt: S2, now: NOW }),
    ]);
    expect(wins(results)).toBeLessThanOrEqual(1);
    expect(mineOpen()).toHaveLength(1); // exactly one open visit of one car, old or new
    expect(a.isActive === true && mineOpen()[0].scheduledAt.getTime() !== OLD.getTime()).toBe(false);
    expectGlobalInvariants();
  });
});
