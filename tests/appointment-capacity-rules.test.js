/**
 * @file appointment-capacity-rules.test.js
 * @description Slot capacity comes from the Admin setting `maxGuestsPerSlot`: the booking rule,
 * the customer grid and the staff grid all follow it, and a lowered capacity never touches
 * existing visits.
 *
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-201
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-202
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-203
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { evaluateBooking, Violation } from '../src/services/appointmentBookingRules.js';
import { createVisit } from '../src/services/appointmentBookingService.js';
import { getSlots } from '../src/services/appointmentSlotService.js';
import { getStaffSlots } from '../src/services/appointmentStaffSlotService.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';

const fakes = await setupAppointmentFakes();
jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);
beforeEach(() => fakes.reset());

const NOW = new Date('2026-11-08T00:00:00Z'); // Sunday 07:00 VN
const TEN = new Date('2026-11-10T03:00:00Z'); // Tuesday 10:00 VN
const ONE_PM = new Date('2026-11-10T06:00:00Z'); // Tuesday 13:00 VN
const userId = new mongoose.Types.ObjectId();
const reject = (promise) => promise.then(() => null, (error) => error);
const slotAt = (result, hhmm) => result.days.find((d) => d.date === '2026-11-10').slots.find((s) => s.start.includes(`T${hhmm}:`));

/** `n` other customers, each holding one car at `at`. */
const fill = (n, at) => Array.from({ length: n }, () =>
  fakes.addAppointment({ customer: fakes.addCustomer()._id, car: fakes.addCar()._id, scheduledAt: at }));
const book = (customer, extra = {}) => createVisit({
  userId, customerId: customer._id, carIds: [String(fakes.addCar()._id)], scheduledAt: TEN, now: NOW, ...extra,
});
const customerGrid = (customer) => getSlots({
  customerId: customer._id, carIds: [String(fakes.addCar()._id)], from: '2026-11-10', to: '2026-11-10', now: NOW,
});
const staffGrid = () => getStaffSlots({ from: '2026-11-10', to: '2026-11-10', now: NOW });

describe('evaluateBooking takes the capacity as a parameter (REQ-201)', () => {
  const row = (customer) => ({ _id: `r-${customer}`, customer, car: `c-${customer}`, scheduledAt: TEN, status: 'PENDING', isActive: true });
  const check = (capacity, held) => evaluateBooking({
    slotRows: held.map(row), customerRows: [], customerId: 'me', carIds: ['mine'], scheduledAt: TEN, now: NOW, capacity,
  });

  it('is full when the visits of other customers reach the capacity', () => {
    expect(check(3, ['a', 'b', 'c'])).toEqual({ kind: Violation.CAPACITY });
    expect(check(3, ['a', 'b'])).toBeNull();
    expect(check(1, ['a'])).toEqual({ kind: Violation.CAPACITY });
    expect(check(5, ['a', 'b', 'c', 'd'])).toBeNull();
  });

  it('falls back to the default capacity (3) when none is passed', () => {
    const verdict = (held) => evaluateBooking({
      slotRows: held.map(row), customerRows: [], customerId: 'me', carIds: ['mine'], scheduledAt: TEN, now: NOW,
    });
    expect(verdict(['a', 'b'])).toBeNull();
    expect(verdict(['a', 'b', 'c'])).toEqual({ kind: Violation.CAPACITY });
  });
});

describe('booking follows the Admin setting (AC-01)', () => {
  it('capacity 3: three customers fill the slot, the fourth gets CAPACITY_FULL, the 13:00 slot is open', async () => {
    fakes.capacity = 3;
    fill(3, TEN);
    const error = await reject(book(fakes.addCustomer()));
    expect(error).toMatchObject({ statusCode: 409 });
    expect(error.message).toMatch(/hết chỗ|đầy|full/i);
    expect(fakes.appointments).toHaveLength(3); // nothing was written
    await expect(book(fakes.addCustomer(), { scheduledAt: ONE_PM })).resolves.toBeDefined();
  });

  it('capacity 3 still admits the third customer', async () => {
    fakes.capacity = 3;
    fill(2, TEN);
    await expect(book(fakes.addCustomer())).resolves.toBeDefined();
  });

  it('capacity 1 admits only one customer', async () => {
    fakes.capacity = 1;
    await book(fakes.addCustomer());
    expect(await reject(book(fakes.addCustomer()))).toMatchObject({ statusCode: 409 });
  });
});

describe('lowering the capacity (AC-02, REQ-203)', () => {
  it('a slot that already holds more visits than the new capacity is full, and nothing is touched', async () => {
    fakes.capacity = 3;
    fill(3, TEN);
    const before = JSON.parse(JSON.stringify(fakes.appointments));
    fakes.capacity = 2; // Admin lowers it
    const me = fakes.addCustomer();
    expect(slotAt(await customerGrid(me), '10:00')).toMatchObject({ available: false, reason: 'CAPACITY_FULL' });
    expect(slotAt(await staffGrid(), '10:00')).toMatchObject({ available: false, reason: 'CAPACITY_FULL', capacityRemaining: 0 });
    expect(await reject(book(me))).toMatchObject({ statusCode: 409 });
    expect(JSON.parse(JSON.stringify(fakes.appointments))).toEqual(before); // existing visits untouched
  });

  it('opens again once the visits drop below the capacity', async () => {
    fakes.capacity = 2;
    const rows = fill(3, TEN);
    const me = fakes.addCustomer();
    expect(slotAt(await customerGrid(me), '10:00').available).toBe(false);
    rows[0].status = 'CANCELLED';
    expect(slotAt(await customerGrid(me), '10:00').available).toBe(false); // 2 left = capacity 2
    rows[1].status = 'CANCELLED';
    expect(slotAt(await customerGrid(me), '10:00').available).toBe(true); // 1 left < capacity 2
  });
});

describe('visits count, not cars (AC-03)', () => {
  it('a customer with three cars takes ONE place', async () => {
    fakes.capacity = 2;
    const me = fakes.addCustomer();
    const cars = [fakes.addCar(), fakes.addCar(), fakes.addCar()];
    await createVisit({ userId, customerId: me._id, carIds: cars.map((c) => String(c._id)), scheduledAt: TEN, now: NOW });
    expect(fakes.appointments).toHaveLength(3);
    expect(slotAt(await staffGrid(), '10:00')).toMatchObject({ available: true, capacityRemaining: 1 });
    await expect(book(fakes.addCustomer())).resolves.toBeDefined(); // the second place is still free
  });
});

describe('grid and booking agree (AC-04, REQ-202)', () => {
  it.each([1, 2, 3, 4])('capacity %i: "available" slots can be booked, "full" slots are refused', async (capacity) => {
    fakes.capacity = capacity;
    fill(2, TEN);
    const me = fakes.addCustomer();
    const slot = slotAt(await customerGrid(me), '10:00');
    const attempt = await reject(book(me));
    if (slot.available) expect(attempt).toBeNull();
    else {
      expect(slot.reason).toBe('CAPACITY_FULL');
      expect(attempt).toMatchObject({ statusCode: 409 });
    }
  });

  it('the staff grid reports the places left from the setting', async () => {
    fakes.capacity = 4;
    fill(1, TEN);
    expect(slotAt(await staffGrid(), '10:00')).toMatchObject({ available: true, capacityRemaining: 3 });
  });
});
