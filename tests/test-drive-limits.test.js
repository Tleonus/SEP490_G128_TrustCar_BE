/**
 * @file test-drive-limits.test.js
 * @description Per-customer booking limits, the no-show lock and staff selection.
 * Time is pinned to 2026-11-09 07:30 in Vietnam.
 */

import { setupTestDriveHarness } from './helpers/fakeTestDriveModels.js';

const h = await setupTestDriveHarness();
const { jest } = await import('@jest/globals');
const { default: mongoose } = await import('mongoose');
const { assertCanBook, computeLockedUntil } = await import('../src/services/testDriveLimits.js');
const { assertStaffAssignable, pickFreeStaff } = await import('../src/services/testDriveAssignment.js');

const NOW = new Date('2026-11-09T00:30:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const FUTURE = new Date('2026-11-12T02:00:00.000Z');
const ago = (days) => new Date(NOW.getTime() - days * DAY);
const session = {};

let customerId;
let carId;

beforeEach(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'hrtime', 'performance'],
  });
  h.reset();
  customerId = String(new mongoose.Types.ObjectId());
  carId = h.createCar();
});

afterEach(() => jest.useRealTimers());

const book = (overrides) => h.insertAppointment({
  customer: customerId, car: h.createCar(), scheduledAt: FUTURE, createdAt: ago(5), ...overrides,
});
const check = () => assertCanBook({ customerId, carId, session });

describe('computeLockedUntil', () => {
  test('one no-show does not lock', () => {
    expect(computeLockedUntil([ago(1)], NOW)).toBeNull();
  });

  test('two no-shows 10 days apart lock for 30 days from the latest', () => {
    expect(computeLockedUntil([ago(1), ago(11)], NOW)).toEqual(new Date(ago(1).getTime() + 30 * DAY));
  });

  test('no-shows more than 30 days apart do not lock', () => {
    expect(computeLockedUntil([ago(1), ago(32)], NOW)).toBeNull();
  });

  test('the lock ends 30 days after the latest no-show', () => {
    expect(computeLockedUntil([ago(30), ago(40)], NOW)).toBeNull();
  });
});

describe('assertCanBook', () => {
  test('passes for a customer with no history', async () => {
    await expect(check()).resolves.toBeUndefined();
  });

  test('refuses a third upcoming booking', async () => {
    book({ scheduledAt: new Date(FUTURE.getTime() + DAY) });
    book();
    await expect(check()).rejects.toMatchObject({ statusCode: 409, code: 'ACTIVE_BOOKING_LIMIT' });
  });

  test('a past PENDING booking does not count as upcoming', async () => {
    book({ scheduledAt: ago(1) });
    book({ scheduledAt: ago(2) });
    await expect(check()).resolves.toBeUndefined();
  });

  test('refuses a second upcoming booking for the same car', async () => {
    book({ car: carId });
    await expect(check()).rejects.toMatchObject({ statusCode: 409, code: 'CAR_BOOKING_LIMIT' });
  });

  test('counts cancelled bookings towards the daily limit', async () => {
    [1, 2, 3].forEach(() => book({ status: 'CANCELLED', createdAt: NOW }));
    await expect(check()).rejects.toMatchObject({ statusCode: 409, code: 'DAILY_BOOKING_LIMIT' });
  });

  test('the daily limit follows the Vietnam calendar day', async () => {
    // 23:30 Vietnam time yesterday is 16:30 UTC, a different local day from now.
    [1, 2, 3].forEach(() => book({ status: 'CANCELLED', createdAt: new Date('2026-11-08T16:30:00.000Z') }));
    await expect(check()).resolves.toBeUndefined();
  });

  test('refuses after 3 completed test drives in 30 days', async () => {
    [1, 2, 3].forEach((i) => book({ status: 'COMPLETED', scheduledAt: ago(i), completedAt: ago(i) }));
    await expect(check()).rejects.toMatchObject({ statusCode: 409, code: 'COMPLETED_LIMIT' });
  });

  test('older completed test drives do not count', async () => {
    [1, 2, 3].forEach((i) => book({ status: 'COMPLETED', scheduledAt: ago(30 + i), completedAt: ago(30 + i) }));
    await expect(check()).resolves.toBeUndefined();
  });

  test('two recent no-shows lock booking and report when it ends', async () => {
    book({ status: 'NO_SHOW', scheduledAt: ago(1) });
    book({ status: 'NO_SHOW', scheduledAt: ago(11) });
    await expect(check()).rejects.toMatchObject({
      statusCode: 403, code: 'BOOKING_LOCKED', errors: { lockedUntil: new Date(ago(1).getTime() + 30 * DAY).toISOString() },
    });
  });

  test('correcting one no-show removes the lock', async () => {
    const first = book({ status: 'NO_SHOW', scheduledAt: ago(1) });
    book({ status: 'NO_SHOW', scheduledAt: ago(11) });
    h.appointment(first).status = 'COMPLETED';
    await expect(check()).resolves.toBeUndefined();
  });
});

describe('staff selection', () => {
  const start = FUTURE;
  const end = new Date(FUTURE.getTime() + 60 * 60 * 1000);
  const appointment = (assignedTo, scheduledAt = FUTURE) => ({ assignedTo, scheduledAt, durationMinutes: 60 });

  test('skips busy staff and prefers the fewest appointments that day', () => {
    const later = new Date(FUTURE.getTime() + 2 * 60 * 60 * 1000);
    expect(pickFreeStaff({
      startAt: start, endAt: end, staffIds: ['a', 'b', 'c'],
      dayAppointments: [appointment('a'), appointment('b', later), appointment('b', new Date(later.getTime() + 3600000)), appointment('c', later)],
    })).toBe('c');
  });

  test('a previous-evening appointment does not count towards that day\'s load', () => {
    const yesterday = new Date(FUTURE.getTime() - 24 * 60 * 60 * 1000);
    expect(pickFreeStaff({
      startAt: start, endAt: end, staffIds: ['b', 'a'],
      dayAppointments: [appointment('a', yesterday), appointment('b', new Date(FUTURE.getTime() + 2 * 60 * 60 * 1000))],
    })).toBe('a');
  });

  test('returns null when everyone is busy', () => {
    expect(pickFreeStaff({ startAt: start, endAt: end, staffIds: ['a'], dayAppointments: [appointment('a')] })).toBeNull();
  });

  test('rejects a non-staff or inactive account', async () => {
    const target = { _id: new mongoose.Types.ObjectId(), scheduledAt: FUTURE, durationMinutes: 60 };
    const customer = await h.createUser({ roleName: 'CUSTOMER' });
    const inactive = await h.createUser({ roleName: 'SALES_STAFF', isActive: false });
    await expect(assertStaffAssignable(customer.id, target)).rejects.toMatchObject({ statusCode: 422, code: 'STAFF_INVALID' });
    await expect(assertStaffAssignable(inactive.id, target)).rejects.toMatchObject({ statusCode: 422, code: 'STAFF_INVALID' });
  });

  test('rejects staff busy at that time, ignoring the appointment being reassigned', async () => {
    const busy = await h.createUser({ roleName: 'SALES_STAFF' });
    const existing = book({ assignedTo: busy.id });
    const other = { _id: new mongoose.Types.ObjectId(), scheduledAt: FUTURE, durationMinutes: 60 };
    await expect(assertStaffAssignable(busy.id, other)).rejects.toMatchObject({ statusCode: 409, code: 'STAFF_NOT_AVAILABLE' });
    await expect(assertStaffAssignable(busy.id, { ...other, _id: existing })).resolves.toBeUndefined();
  });
});
