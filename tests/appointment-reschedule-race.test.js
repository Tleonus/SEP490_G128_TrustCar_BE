/**
 * @file appointment-reschedule-race.test.js
 * @description Concurrency and failure handling of rescheduling, with the real service and
 * in-memory models. A move is ONE transaction (appointmentRescheduleService.js): a hook injects
 * other requests at exact moments inside it, or holds requests together (barrier).
 *
 * Whatever happens, after every request has finished:
 *   INV-10  the customer has EITHER the untouched old visit OR the new visit, never both
 *           open and never (unless they cancelled) neither; a failed move changes NOTHING;
 *   INV-11  from one old visit at most one move succeeds;
 *   INV-2/3/4  one open row per car and slot, at most 2 customers per slot, at most 2 open
 *           visits per customer;
 *   holds   a row that is not open carries no hold, and no two visits share a seat.
 *
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-210
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-216
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#AC-17
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
  fakes.enableIndexes();
  fakes.allowDuplicateCodes(); // the car/seat indexes are what separates concurrent requests here
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
  // Holds: a row that is not open carries none; no two open visits share a seat at one slot.
  expect(fakes.appointments.filter((r) => !open.includes(r) && (r.holdsCar !== undefined || r.visitSeat !== undefined))).toEqual([]);
  const seats = open.filter((r) => typeof r.visitSeat === 'number').map((r) => `${r.scheduledAt.getTime()}|${r.visitSeat}`);
  expect(new Set(seats).size).toBe(seats.length);
  // A reschedule leftover is never visible.
  expect(fakes.appointments.filter((r) => r.isActive && String(r.cancellationReason ?? '').startsWith('RESCHEDULED:'))).toEqual([]);
};

/**
 * Every request pauses at its `create` call (`phase`: 'before' = checked but not written yet,
 * 'after' = written) until `n` requests are paused together. A request that never arrives
 * (refused earlier, or blocked by a write conflict) lets the others go after a short grace time.
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
  // Both moves belong to one customer, so they queue on the customer's document. The second one
  // retries, re-reads the visit, finds it already moved and is refused (409): exactly one wins.
  it('both start at once: exactly one wins, the other is told the visit changed', async () => {
    const [a] = [row(me, OLD)];
    const results = await settle([move(S1, a._id), move(S2, a._id)]);
    expect(wins(results)).toBe(1);
    expect(results.filter((r) => r.status === 'rejected').map(codeOf)).toEqual(['APPOINTMENT_STATUS_INVALID']);
    expect(mineOpen()).toHaveLength(1);
    expect(a).toMatchObject({ isActive: false, status: 'CANCELLED' });
    expectGlobalInvariants();
    expect(await fakes.flushMail()).toHaveLength(1); // only the winner is told
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(fakes.openTransactions).toBe(0);
  });

  it('the second request starts while the first is inside its transaction: the first wins alone, the second leaves nothing', async () => {
    const [a] = [row(me, OLD)];
    let other;
    injectOnce('updateMany', 'before', async () => { other = await settle([move(S2, a._id)]); });
    const first = await move(S1, a._id);
    expect(first.visit.scheduledAt).toBe(S1.toISOString());
    expect(wins(other)).toBe(0); // blocked by the first (write conflict), never gets in
    expect(mineOpen()).toHaveLength(1);
    expect(mineOpen()[0].scheduledAt).toEqual(S1);
    expect(a).toMatchObject({ isActive: false });
    expectGlobalInvariants();
    expect(await fakes.flushMail()).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('with another open visit the customer ends with two visits, never three', async () => {
    const [a] = [row(me, OLD)];
    row(me, new Date('2026-11-15T03:00:00Z'));
    const results = await settle([move(S1, a._id), move(S2, a._id)]);
    expect(wins(results)).toBe(1);
    expect(slotsOf(mineOpen())).toHaveLength(2);
    expectGlobalInvariants();
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
  /** Runs `inject` once, at the first Appointment read INSIDE a transaction. */
  const injectInTransaction = (phase, inject) => {
    let fired = false;
    fakes.hook = async (call) => {
      if (fired || call.model !== 'Appointment' || call.method !== 'find' || call.phase !== phase || fakes.openTransactions === 0) return;
      fired = true;
      await inject();
    };
  };

  it('the customer cancels between the re-read and the retirement: the cancel wins and nothing new stays open', async () => {
    const [a] = [row(me, OLD, { holdsCar: true, visitSeat: 1 })];
    injectOnce('updateMany', 'before', () => cancelMyVisit({ customerId: me._id, userId, id: a._id, now: NOW }));
    const error = await move(S1, a._id).catch((e) => e);
    expect(error.code).toBe('APPOINTMENT_STATUS_INVALID');
    expect(a).toMatchObject({ status: 'CANCELLED', isActive: true });
    expect(fakes.appointments).toEqual([a]); // no new row, nothing hidden
    expect(mineOpen()).toHaveLength(0);
    expectGlobalInvariants();
  });

  it('the customer cancels just before the move re-reads the visit: same outcome', async () => {
    const [a] = [row(me, OLD)];
    injectInTransaction('before', () => cancelMyVisit({ customerId: me._id, userId, id: a._id, now: NOW }));
    const error = await move(S1, a._id).catch((e) => e);
    expect(error.code).toBe('APPOINTMENT_STATUS_INVALID');
    expect(mineOpen()).toHaveLength(0);
    expect(fakes.appointments).toEqual([a]);
    expectGlobalInvariants();
  });

  it('the customer cancels right after the move re-read the visit: same outcome', async () => {
    const [a] = [row(me, OLD)];
    injectInTransaction('after', () => cancelMyVisit({ customerId: me._id, userId, id: a._id, now: NOW }));
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
  it('two others fill the target slot between the check and the write: the move loses and the old visit stays whole', async () => {
    const [a] = [row(me, OLD, { holdsCar: true, visitSeat: 1 })];
    const [x, y] = [fakes.addCustomer(), fakes.addCustomer()];
    injectOnce('create', 'before', async () => {
      await createVisit({ userId, customerId: x._id, carIds: [String(fakes.addCar()._id)], scheduledAt: S1, now: NOW });
      await createVisit({ userId, customerId: y._id, carIds: [String(fakes.addCar()._id)], scheduledAt: S1, now: NOW });
    });
    const error = await move(S1, a._id).catch((e) => e);
    expect(error.code).toBe('APPOINTMENT_CAPACITY_FULL');
    // The whole move rolled back: the old row is open WITH its holds, nothing hidden, nothing new of mine.
    expect(a).toMatchObject({ isActive: true, status: 'PENDING', holdsCar: true, visitSeat: 1 });
    expect(fakes.appointments.filter((r) => String(r.customer) === String(me._id))).toEqual([a]);
    expect(mineOpen()).toHaveLength(1);
    expectGlobalInvariants();
  });

  it('a booking and a move write at the same time into a slot with one place left: not both stay', async () => {
    const [a] = [row(me, OLD)];
    row(fakes.addCustomer(), S1, { holdsCar: true, visitSeat: 1 }); // one place taken, one left
    const newcomer = fakes.addCustomer();
    barrier(2, 'before'); // both pass their checks, then both write
    const results = await settle([
      move(S1, a._id),
      createVisit({ userId, customerId: newcomer._id, carIds: [String(fakes.addCar()._id)], scheduledAt: S1, now: NOW }),
    ]);
    expect(wins(results)).toBe(1);
    const guests = new Set(openRows().filter((r) => r.scheduledAt.getTime() === S1.getTime()).map((r) => String(r.customer)));
    expect(guests.size).toBe(2);
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
    expect(wins(results)).toBe(1);
    expectGlobalInvariants();
    const holders = openRows().filter((r) => String(r.car) === String(a.car) && r.scheduledAt.getTime() === S1.getTime());
    expect(holders).toHaveLength(1);
    expect(a.isActive === true && mineOpen().some((r) => r.scheduledAt.getTime() === S1.getTime())).toBe(false);
  });
});

describe('failures in the middle (INV-10: a failed move changes nothing)', () => {
  it('the retirement changes only some of the old rows: the whole move is refused and rolled back', async () => {
    const [a, b] = [
      row(me, OLD, { status: 'CONFIRMED', confirmedBy: userId, confirmedAt: NOW, holdsCar: true, visitSeat: 1 }),
      row(me, OLD, { status: 'CONFIRMED', confirmedBy: userId, confirmedAt: NOW, holdsCar: true }),
    ];
    Appointment.updateMany.mockImplementationOnce(async () => ({ modifiedCount: 1 })); // as if another request closed one row
    const error = await move(S1, a._id).catch((e) => e);
    expect(error.code).toBe('APPOINTMENT_STATUS_INVALID');
    expect(a).toMatchObject({ isActive: true, status: 'CONFIRMED', holdsCar: true, visitSeat: 1 });
    expect(b).toMatchObject({ isActive: true, status: 'CONFIRMED', holdsCar: true });
    expect(fakes.appointments).toHaveLength(2); // nothing new
    expectGlobalInvariants();
    expect(await fakes.flushMail()).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('the retirement query itself fails: the old visit is intact, the error surfaces', async () => {
    const [a] = [row(me, OLD)];
    Appointment.updateMany.mockImplementationOnce(async () => { throw new Error('db down'); });
    await expect(move(S1, a._id)).rejects.toThrow('db down');
    expect(a).toMatchObject({ isActive: true, status: 'PENDING' });
    expect(fakes.appointments).toHaveLength(1);
    expectGlobalInvariants();
  });

  it('writing the second new row fails: the first new row AND the retirement are rolled back', async () => {
    const [a, b] = [row(me, OLD, { holdsCar: true, visitSeat: 1 }), row(me, OLD, { holdsCar: true })];
    let creates = 0;
    fakes.hook = async ({ method, phase }) => {
      if (method === 'create' && phase === 'before') { creates += 1; if (creates === 2) throw new Error('write failed'); }
    };
    await expect(move(S1, a._id)).rejects.toThrow('write failed');
    expect(a).toMatchObject({ isActive: true, status: 'PENDING', holdsCar: true, visitSeat: 1 });
    expect(b).toMatchObject({ isActive: true, status: 'PENDING', holdsCar: true });
    expect(fakes.appointments).toHaveLength(2); // no new row, nothing hidden
    expect(fakes.openTransactions).toBe(0);
    expectGlobalInvariants();
  });

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

describe('the move swaps the holds in one step (AC-17, REQ-216)', () => {
  it('old rows are hidden with RESCHEDULED:<new code> and lose their holds; new rows hold the car, one holds the seat', async () => {
    const [a, b] = [row(me, OLD, { holdsCar: true, visitSeat: 1 }), row(me, OLD, { holdsCar: true })];
    const { visit } = await move(S1, a._id);
    expect(visit.appointments).toHaveLength(2);
    [a, b].forEach((old) => {
      expect(old).toMatchObject({ isActive: false, status: 'CANCELLED', cancellationReason: `RESCHEDULED:${visit.visitCode}` });
      expect(old).not.toHaveProperty('holdsCar');
      expect(old).not.toHaveProperty('visitSeat');
    });
    const fresh = fakes.appointments.filter((r) => r.scheduledAt.getTime() === S1.getTime());
    expect(fresh).toHaveLength(2);
    expect(fresh.every((r) => r.holdsCar === true)).toBe(true);
    expect(fresh.filter((r) => typeof r.visitSeat === 'number')).toHaveLength(1);
    expect(fresh.find((r) => typeof r.visitSeat === 'number').appointmentCode).toBe(visit.visitCode);
    expectGlobalInvariants();
  });

  it('the old slot is free for somebody else straight after the move', async () => {
    fakes.capacity = 1;
    const [a] = [row(me, OLD, { holdsCar: true, visitSeat: 1 })];
    await move(S1, a._id);
    const other = fakes.addCustomer();
    await expect(createVisit({ userId, customerId: other._id, carIds: [String(a.car)], scheduledAt: OLD, now: NOW })).resolves.toBeDefined();
  });

  it('a move to the slot the visit already has is refused as a duplicate and nothing changes', async () => {
    const [a] = [row(me, OLD, { holdsCar: true, visitSeat: 1 })];
    const error = await move(OLD, a._id).catch((e) => e);
    expect(error.code).toBe('APPOINTMENT_DUPLICATE');
    expect(fakes.appointments).toEqual([a]);
  });
});

describe('staff move racing the customer', () => {
  it('staff and the customer move the same visit at once: never both, and the visit is never lost', async () => {
    const [a] = [row(me, OLD)];
    fakes.addUser({ _id: userId, fullName: 'Lan' });
    const results = await settle([
      move(S1, a._id),
      rescheduleVisitAsStaff({ id: a._id, userId, scheduledAt: S2, now: NOW }),
    ]);
    expect(wins(results)).toBe(1);
    expect(mineOpen()).toHaveLength(1); // exactly one open visit of one car, the new one
    expect(mineOpen()[0].scheduledAt.getTime()).not.toBe(OLD.getTime());
    expectGlobalInvariants();
  });
});
