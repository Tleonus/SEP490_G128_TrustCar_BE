/**
 * @file appointment-booking-write.test.js
 * @description createVisit write robustness: APT code retry, cleanup after a failed write or re-check.
 * Rule violations and the happy path are in appointment-booking.test.js; concurrency in appointment-race.test.js.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-003, 012; C15)
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

describe('writing robustness (C15, REQ-012)', () => {
  it('retries when the APT code is taken, then succeeds', async () => {
    let failures = 0;
    fakes.hook = async ({ method, phase }) => {
      if (method === 'create' && phase === 'before' && failures < 2) {
        failures += 1;
        throw Object.assign(new Error('E11000'), { code: 11000, keyPattern: { appointmentCode: 1 } });
      }
    };
    await expect(book({ carIds: ids(1) })).resolves.toBeDefined();
    expect(failures).toBe(2);
    expect(fakes.appointments).toHaveLength(1);
  });

  it('gives a generic 500 after 3 duplicate codes and creates nothing', async () => {
    fakes.hook = async ({ method, phase }) => {
      if (method === 'create' && phase === 'before') {
        throw Object.assign(new Error('E11000'), { code: 11000, keyPattern: { appointmentCode: 1 } });
      }
    };
    const error = await reject(book({ carIds: ids(1) }));
    expect(error).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
    expect(fakes.appointments).toHaveLength(0);
  });

  it('hides already written rows when a later write fails (no stray appointments)', async () => {
    let creates = 0;
    fakes.hook = async ({ method, phase }) => {
      if (method === 'create' && phase === 'before') {
        creates += 1;
        if (creates === 2) throw new Error('disk full');
      }
    };
    const error = await reject(book());
    expect(error.message).toBe('disk full');
    expect(openRows()).toHaveLength(0);
    expect(fakes.appointments[0]).toMatchObject({ isActive: false, status: 'CANCELLED', cancellationReason: 'BOOKING_ABORTED' });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('hides the rows when the re-check itself fails', async () => {
    fakes.hook = async ({ method, phase }) => {
      if (method === 'find' && phase === 'before' && fakes.appointments.length > 0) throw new Error('db down');
    };
    expect((await reject(book())).message).toBe('db down');
    expect(openRows()).toHaveLength(0);
    expect(fakes.appointments.every((r) => r.cancellationReason === 'BOOKING_ABORTED')).toBe(true);
  });

  it('never deletes a row physically (AC-24)', async () => {
    fakes.hook = async ({ method, phase }) => {
      if (method === 'create' && phase === 'before' && fakes.appointments.length === 1) throw new Error('boom');
    };
    await reject(book());
    expect(fakes.appointments).toHaveLength(1);
  });
});
