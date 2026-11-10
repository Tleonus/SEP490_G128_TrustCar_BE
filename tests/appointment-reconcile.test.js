/**
 * @file appointment-reconcile.test.js
 * @description Reconciliation: open future appointments whose car is no longer sellable are
 * cancelled (same reason, audit and e-mail as the car hook) when staff open the list or try
 * to confirm. Cheap when idle (2 reads, 0 writes) and never able to break the page.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-021, REQ-027, NFR-08; AC-20, AC-27)
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { reconcileOpenAppointments, reconcileCars } from '../src/services/appointmentReconcileService.js';
import { listVisits, changeVisitStatus } from '../src/services/appointmentStaffService.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';
import { default as Appointment } from '../src/models/Appointment.js';

const fakes = await setupAppointmentFakes();
const logSpy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const NOW = new Date('2026-11-08T00:00:00Z');
const SLOT = new Date('2026-11-10T03:00:00Z');
const staffId = new mongoose.Types.ObjectId();
let guest;

beforeEach(() => {
  fakes.reset(); logSpy.mockClear();
  guest = fakes.addCustomer({ fullName: 'Khách Một', email: 'khach@example.com' });
});

const row = (car, extra = {}) => fakes.addAppointment({ customer: guest._id, car: car._id, scheduledAt: SLOT, createdAt: NOW, ...extra });
const reject = (promise) => promise.then(() => null, (error) => error);
const writes = () => fakes.count('Appointment', 'updateMany') + fakes.count('Appointment', 'findOneAndUpdate');

describe('reconcileOpenAppointments (REQ-027)', () => {
  it('cancels the appointment of a car that was sold behind the hook\'s back, and only that one', async () => {
    const sold = fakes.addCar({ status: 'SOLD' });
    const fine = fakes.addCar();
    const bad = row(sold);
    const good = row(fine);
    expect(await reconcileOpenAppointments({ userId: staffId, now: NOW })).toBe(1);
    expect(bad).toMatchObject({ status: 'CANCELLED', cancellationReason: 'AUTO_CAR_UNAVAILABLE:SOLD' });
    expect(String(bad.updatedBy)).toBe(String(staffId));
    expect(good.status).toBe('PENDING');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(await fakes.flushMail()).toHaveLength(1);
  });

  it('treats a RESERVED car like any other non-sellable car and an inactive car as REMOVED', async () => {
    const reserved = fakes.addCar({ status: 'RESERVED' });
    const removed = fakes.addCar({ isActive: false });
    const a = row(reserved); const b = row(removed);
    await reconcileOpenAppointments({ now: NOW });
    expect(a.cancellationReason).toBe('AUTO_CAR_UNAVAILABLE:RESERVED');
    expect(b.cancellationReason).toBe('AUTO_CAR_UNAVAILABLE:REMOVED');
    expect((await fakes.flushMail()).some((m) => m.html.includes('giữ chỗ'))).toBe(true);
  });

  it('ignores past, closed and already-hidden rows', async () => {
    const sold = fakes.addCar({ status: 'SOLD' });
    const past = row(sold, { scheduledAt: new Date('2026-11-01T03:00:00Z') });
    const done = row(sold, { status: 'COMPLETED' });
    const hidden = row(sold, { isActive: false });
    expect(await reconcileOpenAppointments({ now: NOW })).toBe(0);
    expect([past.status, done.status, hidden.status]).toEqual(['PENDING', 'COMPLETED', 'PENDING']);
  });

  it('running it again changes nothing and sends nothing (idempotent)', async () => {
    row(fakes.addCar({ status: 'SOLD' }));
    await reconcileOpenAppointments({ now: NOW });
    const before = writes();
    expect(await reconcileOpenAppointments({ now: NOW })).toBe(0);
    expect(writes() - before).toBe(0);
    expect(await fakes.flushMail()).toHaveLength(1);
  });

  it('costs 2 reads and 0 writes when nothing needs cancelling (NFR-08)', async () => {
    row(fakes.addCar());
    const reads = () => fakes.count('Appointment', 'find') + fakes.count('Car', 'find');
    const beforeReads = reads(); const beforeWrites = writes();
    expect(await reconcileOpenAppointments({ now: NOW })).toBe(0);
    expect(reads() - beforeReads).toBe(2);
    expect(writes() - beforeWrites).toBe(0);
  });

  it('with no open future appointment it stops after one read', async () => {
    const before = fakes.count('Appointment', 'find') + fakes.count('Car', 'find');
    await reconcileOpenAppointments({ now: NOW });
    expect(fakes.count('Appointment', 'find') + fakes.count('Car', 'find') - before).toBe(1);
  });

  it('never throws: a database error is reported and the answer is 0', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    Appointment.find.mockImplementationOnce(() => { throw new Error('db down'); });
    await expect(reconcileOpenAppointments({ now: NOW })).resolves.toBe(0);
    expect(quiet).toHaveBeenCalledWith('Appointment reconciliation failed:', 'db down');
    quiet.mockRestore();
  });
});

describe('reconcileCars', () => {
  it('only looks at the given cars', async () => {
    const soldA = fakes.addCar({ status: 'SOLD' }); const soldB = fakes.addCar({ status: 'SOLD' });
    const a = row(soldA); const b = row(soldB);
    expect(await reconcileCars({ carIds: [String(soldA._id)], userId: staffId })).toBe(1);
    expect([a.status, b.status]).toEqual(['CANCELLED', 'PENDING']);
  });
});

describe('staff list (AC-27)', () => {
  it('reconciles first, so the list already shows the cancelled appointment', async () => {
    const sold = fakes.addCar({ status: 'SOLD' });
    row(sold);
    const { visits } = await listVisits({ userId: staffId, now: NOW });
    expect(visits[0]).toMatchObject({ status: 'CANCELLED', cancellationType: 'CAR_UNAVAILABLE' });
    expect(visits[0].appointments[0].car.status).toBe('SOLD');
    const again = await listVisits({ userId: staffId, now: NOW });
    expect(again.visits).toHaveLength(1);
    expect(await fakes.flushMail()).toHaveLength(1);
  });

  it('a failing reconciliation does not break the list', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    row(fakes.addCar());
    Appointment.find.mockImplementationOnce(() => { throw new Error('db down'); });
    const { visits } = await listVisits({ now: NOW });
    expect(visits).toHaveLength(1);
    quiet.mockRestore();
  });
});

describe('confirming (REQ-021, AC-20)', () => {
  it('refuses with 409 after cancelling the appointment of the unsellable car; the other car stays', async () => {
    const sold = fakes.addCar({ status: 'SOLD' });
    const bad = row(sold); const good = row(fakes.addCar());
    const error = await reject(changeVisitStatus({ id: bad._id, userId: staffId, status: 'CONFIRMED', now: NOW }));
    expect(error).toMatchObject({ statusCode: 409, code: 'APPOINTMENT_CAR_UNAVAILABLE' });
    expect(bad.status).toBe('CANCELLED');
    expect(good.status).toBe('PENDING');
    expect(await fakes.flushMail()).toHaveLength(1); // the customer learns about it, once
  });

  it('confirms normally (no reconciliation write) when every car is sellable', async () => {
    const a = row(fakes.addCar());
    const before = fakes.count('Appointment', 'findOneAndUpdate');
    await changeVisitStatus({ id: a._id, userId: staffId, status: 'CONFIRMED', now: NOW });
    expect(a.status).toBe('CONFIRMED');
    expect(fakes.count('Appointment', 'findOneAndUpdate') - before).toBe(0); // no reconciliation happened
  });
});
