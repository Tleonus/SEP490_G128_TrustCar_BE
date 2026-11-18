/**
 * @file appointment-holds-release.test.js
 * @description Every way a row stops being open releases its holds IN THE SAME UPDATE, and the
 * visit's seat moves to a remaining car when the seat-holding row of a several-car visit is
 * cancelled. After each scenario the shared invariant check must find nothing.
 *
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-214
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-215
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#AC-15
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#AC-16
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#AC-19
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { holdViolations } from './helpers/appointmentInvariants.js';
import { cancelOpenAppointmentsForCar, releaseAppointmentsForCar } from '../src/services/appointmentAutoCancelService.js';
import { reconcileOpenAppointments } from '../src/services/appointmentReconcileService.js';
import { cancelMyVisit } from '../src/services/appointmentCustomerService.js';
import { changeVisitStatus } from '../src/services/appointmentStaffService.js';
import { createVisit } from '../src/services/appointmentBookingService.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';

const fakes = await setupAppointmentFakes();
const logSpy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const NOW = new Date('2026-11-08T00:00:00Z');
const SLOT = new Date('2026-11-10T03:00:00Z'); // 10:00 VN
const AFTER = new Date(SLOT.getTime() + 3600e3);
const userId = new mongoose.Types.ObjectId();
let anna;

beforeEach(() => {
  fakes.reset(); logSpy.mockClear();
  fakes.enableIndexes();
  fakes.allowDuplicateCodes();
  anna = fakes.addCustomer({ email: 'anna@example.com' });
});
afterEach(() => { expect(holdViolations(fakes.appointments)).toEqual([]); });

/** An open visit of `carCount` cars, written the way booking writes it (lowest code holds the seat). */
const visit = (who, scheduledAt, carCount, { seat = 1, status = 'PENDING' } = {}) => {
  const cars = Array.from({ length: carCount }, () => fakes.addCar());
  const rows = cars.map((car, index) => fakes.addAppointment({
    customer: who._id, car: car._id, scheduledAt, status, createdAt: NOW,
    appointmentCode: `APT-${String(2000 + fakes.appointments.length + 1).padStart(4, '0')}`,
    holdsCar: true, ...(index === 0 ? { visitSeat: seat } : {}),
  }));
  return { cars, rows };
};
const byCode = (rows) => [...rows].sort((a, b) => a.appointmentCode.localeCompare(b.appointmentCode));
const cancelCar = (car, extra = {}) => cancelOpenAppointmentsForCar({ carId: car._id, carStatus: 'SOLD', userId, ...extra });

describe('a seat-holding car of a several-car visit is cancelled (AC-15, REQ-215)', () => {
  it('the seat moves to the remaining car; cancelling that one too leaves no hold at all', async () => {
    const { cars, rows } = visit(anna, SLOT, 2, { seat: 2 });
    const [lead, second] = byCode(rows);
    expect(await cancelCar(cars[rows.indexOf(lead)])).toBe(1);
    expect(lead).toMatchObject({ status: 'CANCELLED', cancellationReason: 'AUTO_CAR_UNAVAILABLE:SOLD' });
    expect(lead).not.toHaveProperty('holdsCar');
    expect(lead).not.toHaveProperty('visitSeat');
    expect(second).toMatchObject({ status: 'PENDING', holdsCar: true, visitSeat: 2 }); // same seat, new holder
    expect(holdViolations(fakes.appointments)).toEqual([]);

    expect(await cancelCar(cars[rows.indexOf(second)])).toBe(1);
    fakes.appointments.forEach((r) => {
      expect(r).not.toHaveProperty('holdsCar');
      expect(r).not.toHaveProperty('visitSeat');
    });
  });

  it('with three cars the seat goes to the remaining row with the LOWEST code', async () => {
    const { cars, rows } = visit(anna, SLOT, 3, { seat: 1 });
    const [lead, middle, last] = byCode(rows);
    await cancelCar(cars[rows.indexOf(lead)]);
    expect(middle.visitSeat).toBe(1);
    expect(last).not.toHaveProperty('visitSeat');
    await cancelCar(cars[rows.indexOf(middle)]);
    expect(last).toMatchObject({ holdsCar: true, visitSeat: 1 });
  });

  it('cancelling a car that does NOT hold the seat leaves the seat where it is', async () => {
    const { cars, rows } = visit(anna, SLOT, 3, { seat: 3 });
    const [lead, middle] = byCode(rows);
    await cancelCar(cars[rows.indexOf(middle)]);
    expect(lead).toMatchObject({ holdsCar: true, visitSeat: 3 });
    expect(middle).not.toHaveProperty('holdsCar');
  });

  it('a visit of another customer at the same time is never touched', async () => {
    fakes.capacity = 3;
    const ben = fakes.addCustomer();
    const mine = visit(anna, SLOT, 2, { seat: 1 });
    const theirs = visit(ben, SLOT, 1, { seat: 2 });
    await cancelCar(mine.cars[0]);
    expect(theirs.rows[0]).toMatchObject({ status: 'PENDING', holdsCar: true, visitSeat: 2 });
  });

  it('the freed car can be booked again straight away by somebody else', async () => {
    const { cars, rows } = visit(anna, SLOT, 1);
    await cancelCar(cars[0]);
    fakes.capacity = 1;
    const ben = fakes.addCustomer();
    // the car is no longer for sale in the real flow; here we only prove the hold is gone
    expect(rows[0]).not.toHaveProperty('holdsCar');
    await expect(createVisit({ userId, customerId: ben._id, carIds: [String(cars[0]._id)], scheduledAt: SLOT, now: NOW })).resolves.toBeDefined();
  });
});

describe('closing by another path releases in the same update (AC-16)', () => {
  it('the customer cancels the whole visit: every row loses its holds and the slot is free again', async () => {
    fakes.capacity = 1;
    const { cars, rows } = visit(anna, SLOT, 2);
    await cancelMyVisit({ customerId: anna._id, userId, id: rows[0]._id, now: NOW });
    rows.forEach((r) => expect(r).toMatchObject({ status: 'CANCELLED' }));
    expect(holdViolations(fakes.appointments)).toEqual([]);
    const ben = fakes.addCustomer();
    await expect(createVisit({ userId, customerId: ben._id, carIds: [String(cars[0]._id)], scheduledAt: SLOT, now: NOW })).resolves.toBeDefined();
  });

  it.each([
    ['CANCELLED', { reasonCode: 'SHOWROOM_BUSY' }, NOW],
    ['COMPLETED', { outcome: 'ok' }, AFTER],
    ['NO_SHOW', {}, AFTER],
  ])('staff set %s: the holds go with the status', async (status, extra, now) => {
    const staff = fakes.addUser({ fullName: 'Lan' });
    const { rows } = visit(anna, SLOT, 2, { status: 'CONFIRMED' });
    await changeVisitStatus({ id: rows[0]._id, userId: staff._id, status, now, ...extra });
    rows.forEach((r) => {
      expect(r.status).toBe(status);
      expect(r).not.toHaveProperty('holdsCar');
      expect(r).not.toHaveProperty('visitSeat');
    });
  });

  it('staff CONFIRM keeps the holds: the visit is still open', async () => {
    const staff = fakes.addUser({ fullName: 'Lan' });
    const { rows } = visit(anna, SLOT, 2);
    await changeVisitStatus({ id: rows[0]._id, userId: staff._id, status: 'CONFIRMED', now: NOW });
    rows.forEach((r) => expect(r).toMatchObject({ status: 'CONFIRMED', holdsCar: true }));
    expect(rows.filter((r) => typeof r.visitSeat === 'number')).toHaveLength(1);
  });

  it('the reconciliation (a car left AVAILABLE without the hook) releases like the hook does', async () => {
    const { cars, rows } = visit(anna, SLOT, 2, { seat: 1 });
    const [lead, second] = byCode(rows);
    fakes.state.cars.find((c) => c._id === cars[rows.indexOf(lead)]._id).status = 'SOLD';
    expect(await reconcileOpenAppointments({ userId, now: NOW })).toBe(1);
    expect(lead).not.toHaveProperty('holdsCar');
    expect(second).toMatchObject({ holdsCar: true, visitSeat: 1 });
  });
});

describe('rows from before the change (AC-19)', () => {
  it('a KAN-28 row holding slotSeat gives the seat back when it is cancelled', async () => {
    const car = fakes.addCar();
    const old = fakes.addAppointment({ customer: anna._id, car: car._id, scheduledAt: SLOT, slotSeat: 2 });
    await cancelCar(car);
    expect(old.status).toBe('CANCELLED');
    expect(old).not.toHaveProperty('slotSeat');
  });

  it('a row without any hold (made before the migration) is cancelled like any other', async () => {
    const car = fakes.addCar();
    const old = fakes.addAppointment({ customer: anna._id, car: car._id, scheduledAt: SLOT });
    await expect(cancelCar(car)).resolves.toBe(1);
    expect(old.status).toBe('CANCELLED');
  });
});

describe('single-car cancellation is atomic and exactly-once', () => {
  it('two cancellations of the same car at once: one changes it, the seat is transferred once', async () => {
    const { cars, rows } = visit(anna, SLOT, 2, { seat: 2 });
    const [lead, second] = byCode(rows);
    const results = await Promise.all([cancelCar(cars[rows.indexOf(lead)]), cancelCar(cars[rows.indexOf(lead)])]);
    expect(results.reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(second).toMatchObject({ holdsCar: true, visitSeat: 2 });
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('a failure while moving the seat rolls the cancellation back: nothing is half done', async () => {
    const { cars, rows } = visit(anna, SLOT, 2, { seat: 1 });
    const [lead, second] = byCode(rows);
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    fakes.hook = async ({ method, phase }) => { if (method === 'updateOne' && phase === 'before') throw new Error('db down'); };
    // the hook entry point never throws (a failure must not block the car change): it reports 0
    expect(await releaseAppointmentsForCar({ carId: cars[rows.indexOf(lead)]._id, carStatus: 'SOLD', userId })).toBe(0);
    fakes.hook = null;
    expect(lead).toMatchObject({ status: 'PENDING', holdsCar: true, visitSeat: 1 }); // not cancelled, not half-released
    expect(second).toMatchObject({ status: 'PENDING', holdsCar: true });
    expect(second).not.toHaveProperty('visitSeat');
    quiet.mockRestore();
    expect(fakes.openTransactions).toBe(0);
  });
});
