/**
 * @file appointment-car-hook.test.js
 * @description The real carService.updateCarStatus / softDeleteCar cancel the open
 * test-drive appointments of a car that stops being sellable, and can never be
 * blocked by a failure of that clean-up.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-022, C8, INV-9; AC-21)
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { updateCarStatus, softDeleteCar } from '../src/services/carService.js';
import { default as Car } from '../src/models/Car.js';
import { default as Appointment } from '../src/models/Appointment.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';

const fakes = await setupAppointmentFakes();
const logSpy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);
const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

const SLOT = new Date('2026-11-10T03:00:00Z');
const userId = new mongoose.Types.ObjectId();
let stored; // the car document carService will load
let customer;

beforeEach(() => {
  fakes.reset(); logSpy.mockClear(); errorSpy.mockClear();
  customer = fakes.addCustomer();
  stored = fakes.addCar();
  stored.save = jest.fn().mockResolvedValue(undefined);
  jest.spyOn(Car, 'findOne').mockImplementation(async () => stored);
});

const appointmentFor = (car, extra = {}) =>
  fakes.addAppointment({ customer: customer._id, car: car._id, scheduledAt: SLOT, ...extra });
const change = (targetStatus) => updateCarStatus({ carId: stored._id, targetStatus, userId });

describe('updateCarStatus (REQ-022, AC-21)', () => {
  it.each(['RESERVED', 'DELISTED'])('AVAILABLE → %s cancels the car\'s open appointments and no others', async (target) => {
    const mine = appointmentFor(stored);
    const confirmed = appointmentFor(stored, { status: 'CONFIRMED', scheduledAt: new Date('2026-11-11T03:00:00Z') });
    const sibling = appointmentFor(fakes.addCar());
    const closed = appointmentFor(stored, { status: 'COMPLETED', scheduledAt: new Date('2026-11-12T03:00:00Z') });

    const car = await change(target);

    expect(car.status).toBe(target);
    expect([mine, confirmed].map((r) => [r.status, r.cancellationReason])).toEqual([
      ['CANCELLED', `AUTO_CAR_UNAVAILABLE:${target}`], ['CANCELLED', `AUTO_CAR_UNAVAILABLE:${target}`],
    ]);
    expect(sibling.status).toBe('PENDING');
    expect(closed.status).toBe('COMPLETED');
    expect(logSpy.mock.calls.map(([e]) => e.eventType).sort()).toEqual([
      'APPOINTMENT_CANCELLED', 'APPOINTMENT_CANCELLED', 'CAR_STATUS_CHANGED',
    ]);
  });

  it('does not look at appointments when the car was not AVAILABLE before', async () => {
    stored.status = 'RESERVED';
    const open = appointmentFor(stored);
    await change('SOLD');
    expect(open.status).toBe('PENDING');
    expect(fakes.count('Appointment')).toBe(0);
  });

  it('a failure while cancelling never blocks or undoes the car status change (C8)', async () => {
    const open = appointmentFor(stored);
    Appointment.find.mockImplementationOnce(() => { throw new Error('appointments down'); });

    const car = await change('RESERVED');

    expect(car.status).toBe('RESERVED');
    expect(stored.save).toHaveBeenCalledTimes(1);
    expect(open.status).toBe('PENDING'); // left for staff; REQ-021 re-checks the car on confirm
    expect(errorSpy).toHaveBeenCalledWith('Appointment auto-cancel failed for car', String(stored._id), 'appointments down');
  });

  it('an invalid transition still fails first and touches no appointment', async () => {
    appointmentFor(stored);
    await expect(change('SOLD')).rejects.toMatchObject({ statusCode: 422 });
    expect(fakes.count('Appointment')).toBe(0);
  });
});

describe('softDeleteCar', () => {
  it('cancels the open appointments with the REMOVED marker', async () => {
    const open = appointmentFor(stored);
    await softDeleteCar({ carId: stored._id, userId });
    expect(stored.isActive).toBe(false);
    expect([open.status, open.cancellationReason]).toEqual(['CANCELLED', 'AUTO_CAR_UNAVAILABLE:REMOVED']);
  });

  it('succeeds even when the clean-up fails', async () => {
    const open = appointmentFor(stored);
    Appointment.find.mockImplementationOnce(() => { throw new Error('appointments down'); });
    await expect(softDeleteCar({ carId: stored._id, userId })).resolves.toBeUndefined();
    expect(stored.isActive).toBe(false);
    expect(open.status).toBe('PENDING');
  });
});
