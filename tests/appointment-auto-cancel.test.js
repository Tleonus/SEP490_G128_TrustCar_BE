/**
 * @file appointment-auto-cancel.test.js
 * @description Auto-cancel of open appointments when a car stops being sellable.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-022, REQ-023, C7, C8, INV-9; AC-21)
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { cancelOpenAppointmentsForCar } from '../src/services/appointmentAutoCancelService.js';
import { getMyVisit } from '../src/services/appointmentCustomerService.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';
import { default as Appointment } from '../src/models/Appointment.js';

const fakes = await setupAppointmentFakes();
const logSpy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const SLOT = new Date('2026-11-10T03:00:00Z');
const OTHER = new Date('2026-11-11T03:00:00Z');
const staffId = new mongoose.Types.ObjectId();
let car;
let anna;
let ben;

beforeEach(() => {
  fakes.reset(); logSpy.mockClear();
  car = fakes.addCar(); anna = fakes.addCustomer(); ben = fakes.addCustomer();
});

const row = (who, theCar, scheduledAt, extra = {}) =>
  fakes.addAppointment({ customer: who._id, car: theCar._id, scheduledAt, ...extra });
const run = (extra = {}) => cancelOpenAppointmentsForCar({ carId: car._id, carStatus: 'RESERVED', userId: staffId, ...extra });

describe('cancelOpenAppointmentsForCar (REQ-022, INV-9)', () => {
  it('cancels every open appointment of that car only, with the machine reason', async () => {
    const a = row(anna, car, SLOT);
    const b = row(ben, car, OTHER, { status: 'CONFIRMED' });
    const closed = row(ben, car, new Date('2026-12-01T03:00:00Z'), { status: 'COMPLETED' });
    const sibling = row(anna, fakes.addCar(), SLOT);
    expect(await run()).toBe(2);
    expect([a, b].map((r) => [r.status, r.cancellationReason])).toEqual([
      ['CANCELLED', 'AUTO_CAR_UNAVAILABLE:RESERVED'], ['CANCELLED', 'AUTO_CAR_UNAVAILABLE:RESERVED'],
    ]);
    expect(String(a.updatedBy)).toBe(String(staffId));
    expect(closed.status).toBe('COMPLETED');
    expect(sibling.status).toBe('PENDING');
  });

  it('logs one APPOINTMENT_CANCELLED per cancelled appointment with the previous status (AC-23)', async () => {
    row(anna, car, SLOT); row(ben, car, OTHER, { status: 'CONFIRMED' });
    await run({ ipAddress: '1.2.3.4' });
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls.map(([e]) => e.changes.before.status).sort()).toEqual(['CONFIRMED', 'PENDING']);
    expect(logSpy.mock.calls[0][0]).toMatchObject({ eventType: 'APPOINTMENT_CANCELLED', performedBy: staffId, ipAddress: '1.2.3.4' });
  });

  it('does nothing and writes nothing when the car has no open appointment', async () => {
    row(anna, car, SLOT, { status: 'CANCELLED' });
    Appointment.updateMany.mockClear();
    expect(await run()).toBe(0);
    expect(Appointment.updateMany).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('keeps working when the audit log fails (the car change must not be blocked)', async () => {
    row(anna, car, SLOT);
    logSpy.mockRejectedValueOnce(new Error('log down'));
    await expect(run()).resolves.toBe(1);
  });

  it('records a soft delete with its own marker', async () => {
    const a = row(anna, car, SLOT);
    await run({ carStatus: 'REMOVED' });
    expect(a.cancellationReason).toBe('AUTO_CAR_UNAVAILABLE:REMOVED');
  });
});

describe('e-mail and exactly-once (REQ-028, INV-12, C24; AC-26)', () => {
  it('a RESERVED car says "being held", a SOLD car says "no longer sold"', async () => {
    row(anna, car, SLOT);
    await run({ carStatus: 'RESERVED' });
    row(ben, car, OTHER);
    await run({ carStatus: 'SOLD' });
    const [held, sold] = await fakes.flushMail();
    expect(held.html).toContain('đang được một khách hàng khác giữ chỗ');
    expect(sold.html).toContain('hiện không còn được bán');
    expect(held.subject).toContain('có xe không còn khả dụng');
  });

  it('sends one e-mail per affected visit/customer, to the right address', async () => {
    anna.email = 'anna@example.com'; ben.email = 'ben@example.com';
    row(anna, car, SLOT); row(ben, car, OTHER); row(ben, car, new Date('2026-11-12T03:00:00Z'));
    await run();
    const sent = await fakes.flushMail();
    expect(sent.map((m) => m.to).sort()).toEqual(['anna@example.com', 'ben@example.com', 'ben@example.com']);
  });

  it('a multi-car visit names the cancelled car and the cars that remain', async () => {
    const kept = fakes.addCar({ make: 'TOYOTA', model: 'Camry', variant: 'Q' });
    car.make = 'MAZDA'; car.model = 'CX-5'; car.variant = 'Lost';
    row(anna, car, SLOT); row(anna, kept, SLOT);
    await run();
    const [mail] = await fakes.flushMail();
    expect(mail.html).toContain('MAZDA CX-5 Lost');
    expect(mail.html).toContain('vẫn được giữ nguyên');
    expect(mail.html).toContain('TOYOTA Camry Q');
  });

  it('a car whose rows were all cancelled says the whole visit is cancelled', async () => {
    row(anna, car, SLOT);
    await run();
    expect((await fakes.flushMail())[0].html).toContain('đã được hủy hoàn toàn');
  });

  it('running it twice (hook and reconciliation) sends and logs once; the second call changes nothing', async () => {
    row(anna, car, SLOT);
    expect(await run()).toBe(1);
    expect(await run()).toBe(0);
    expect(await fakes.flushMail()).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('a row somebody else cancelled between the read and the write is neither counted, logged nor e-mailed', async () => {
    const a = row(anna, car, SLOT); const b = row(ben, car, OTHER);
    fakes.hook = async ({ method, phase }) => {
      // Right after we read the open rows, a staff member cancels Anna's visit.
      if (method === 'find' && phase === 'after' && a.status === 'PENDING') Object.assign(a, { status: 'CANCELLED', cancellationReason: 'OTHER|x' });
    };
    expect(await run()).toBe(1);
    expect(a.cancellationReason).toBe('OTHER|x'); // not overwritten
    expect(b.status).toBe('CANCELLED');
    expect(await fakes.flushMail()).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('an e-mail problem never blocks the cancellation or the return value', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    fakes.mail.fail = true;
    row(anna, car, SLOT);
    await expect(run()).resolves.toBe(1);
    await fakes.flushMail();
    quiet.mockRestore();
  });
});

describe('what the customer sees (C7, FA5)', () => {
  it('a visit whose only car was withdrawn shows CAR_UNAVAILABLE and hides the machine reason', async () => {
    const a = row(anna, car, SLOT);
    await run();
    const visit = await getMyVisit({ customerId: anna._id, id: a._id });
    expect(visit).toMatchObject({ status: 'CANCELLED', cancellationType: 'CAR_UNAVAILABLE', cancellationReason: null, isLateCancellation: false });
  });

  it('in a multi-car visit only that car is cancelled; the visit stays open', async () => {
    const other = fakes.addCar();
    const a = row(anna, car, SLOT);
    const b = row(anna, other, SLOT);
    await run();
    const visit = await getMyVisit({ customerId: anna._id, id: a._id });
    expect(visit.status).toBe('PENDING');
    expect(visit.cancellationType).toBeNull();
    expect(visit.appointments.map((x) => [x._id, x.status])).toEqual([
      [String(a._id), 'CANCELLED'], [String(b._id), 'PENDING'],
    ]);
  });
});
