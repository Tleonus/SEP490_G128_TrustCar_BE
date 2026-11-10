/**
 * @file appointment-staff-booking.test.js
 * @description Staff book a visit for a customer who phoned in: who can be found and booked,
 * CONFIRMED at once, the 2-hour lead time waived, every other rule unchanged, the customer
 * stays the owner (can cancel it), and a race with the customer's own booking.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-038…041, C19, C28; AC-36, AC-37)
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { searchCustomersForStaff, createVisitForCustomer } from '../src/services/appointmentStaffBookingService.js';
import { createVisit } from '../src/services/appointmentBookingService.js';
import { cancelMyVisit, getMyVisit } from '../src/services/appointmentCustomerService.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';

const fakes = await setupAppointmentFakes();
const logSpy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const NOW = new Date('2026-11-08T00:00:00Z');
const SLOT = new Date('2026-11-10T03:00:00Z'); // Tue 10:00 VN
const OTHER_SLOT = new Date('2026-11-11T03:00:00Z');
const staffId = new mongoose.Types.ObjectId();
let customer;

beforeEach(() => {
  fakes.reset(); logSpy.mockClear();
  fakes.addUser({ _id: staffId, fullName: 'Lan Sales' });
  customer = fakes.addCustomer({ fullName: 'Nguyễn An', phone: '0901000111', email: 'an@example.com' });
  fakes.addUser({ customer: customer._id, roleName: 'CUSTOMER', isActive: true });
});

const reject = (promise) => promise.then(() => null, (error) => error);
const carIds = (n = 1) => Array.from({ length: n }, () => String(fakes.addCar()._id));
const book = (extra = {}) => createVisitForCustomer({
  userId: staffId, customerId: customer._id, carIds: carIds(), scheduledAt: SLOT, now: NOW, ...extra,
});
const openRows = () => fakes.appointments.filter((r) => r.isActive && ['PENDING', 'CONFIRMED'].includes(r.status));

describe('customer search (REQ-038, C28)', () => {
  it('finds by name, phone or e-mail, returning exactly four fields', async () => {
    for (const q of ['nguyễn', '090100', 'AN@exam']) {
      const { customers } = await searchCustomersForStaff({ q });
      expect(customers).toEqual([{ _id: customer._id, fullName: 'Nguyễn An', phone: '0901000111', email: 'an@example.com' }]);
    }
  });

  it('needs at least 3 characters (after trimming)', async () => {
    for (const q of ['', 'ab', '  ab ', undefined, 7]) {
      expect((await reject(searchCustomersForStaff({ q }))).code).toBe('VALIDATION_ERROR');
    }
    expect((await searchCustomersForStaff({ q: ' abc ' })).customers).toEqual([]);
  });

  it('never lists a customer without an active account, and returns at most 10', async () => {
    const stranger = fakes.addCustomer({ fullName: 'Nguyễn Không Tài Khoản' });
    const locked = fakes.addCustomer({ fullName: 'Nguyễn Bị Khóa' });
    fakes.addUser({ customer: locked._id, roleName: 'CUSTOMER', isActive: false });
    Array.from({ length: 12 }, (_v, i) => {
      const c = fakes.addCustomer({ fullName: `Nguyễn Khách ${i}` });
      fakes.addUser({ customer: c._id, roleName: 'CUSTOMER', isActive: true });
      return c;
    });
    const { customers } = await searchCustomersForStaff({ q: 'nguyễn' });
    expect(customers).toHaveLength(10);
    const ids = customers.map((c) => String(c._id));
    expect(ids).not.toContain(String(stranger._id));
    expect(ids).not.toContain(String(locked._id));
  });

  it('treats regular-expression characters literally', async () => {
    expect((await searchCustomersForStaff({ q: '.*.*' })).customers).toEqual([]);
  });
});

describe('booking on behalf (REQ-039, C19; AC-37)', () => {
  it('creates CONFIRMED appointments owned by the customer, confirmed and assigned to the staff member', async () => {
    const ids = carIds(2);
    const visit = await book({ carIds: ids, notes: ' khách gọi lúc 9h ' });
    expect(visit).toMatchObject({
      status: 'CONFIRMED', scheduledAt: SLOT.toISOString(), notes: 'khách gọi lúc 9h',
      customer: { _id: String(customer._id), fullName: 'Nguyễn An' },
      confirmedBy: { _id: String(staffId), fullName: 'Lan Sales' }, assignedTo: { _id: String(staffId) },
      rescheduleCount: 0, needsReminderCall: false, needsOutcome: false,
    });
    expect(visit.appointments.map((a) => a.car._id).sort()).toEqual([...ids].sort());
    openRows().forEach((r) => {
      expect(r).toMatchObject({ status: 'CONFIRMED', type: 'TEST_DRIVE', durationMinutes: 90 });
      expect(String(r.customer)).toBe(String(customer._id));
      expect(String(r.createdBy)).toBe(String(staffId));
      expect(String(r.confirmedBy)).toBe(String(staffId));
      expect(r.confirmedAt).toEqual(NOW);
    });
    expect(openRows()).toHaveLength(2);
  });

  it('logs one APPOINTMENT_CREATED per appointment, performed by the staff member', async () => {
    await book({ carIds: carIds(2), ipAddress: '10.0.0.5' });
    expect(logSpy).toHaveBeenCalledTimes(2);
    logSpy.mock.calls.forEach(([entry]) => expect(entry).toMatchObject({
      eventType: 'APPOINTMENT_CREATED', performedBy: staffId, ipAddress: '10.0.0.5',
    }));
  });

  it('e-mails the customer once, saying the visit is already confirmed', async () => {
    const visit = await book();
    const sent = await fakes.flushMail();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('an@example.com');
    expect(sent[0].subject).toBe(`TrustCar: lịch lái thử ${visit.visitCode} đã được xác nhận`);
  });

  it('waives the 2-hour lead time: a slot 30 minutes away is fine, one that started is not', async () => {
    const soon = new Date(SLOT.getTime() - 30 * 60e3);
    expect((await book({ now: soon })).status).toBe('CONFIRMED');
    fakes.reset(); fakes.addUser({ _id: staffId, fullName: 'Lan' });
    customer = fakes.addCustomer(); fakes.addUser({ customer: customer._id, roleName: 'CUSTOMER', isActive: true });
    expect((await reject(book({ now: SLOT }))).code).toBe('APPOINTMENT_TOO_SOON');
    expect((await reject(book({ now: new Date(SLOT.getTime() + 60e3) }))).code).toBe('APPOINTMENT_TOO_SOON');
    expect(openRows()).toHaveLength(0);
  });

  it('keeps the slot grid and the 60-day horizon (422)', async () => {
    expect((await reject(book({ scheduledAt: new Date('2026-11-10T03:30:00Z') }))).code).toBe('APPOINTMENT_SLOT_INVALID');
    expect((await reject(book({ scheduledAt: new Date('2027-02-12T03:00:00Z') }))).code).toBe('APPOINTMENT_TOO_FAR');
    expect(openRows()).toHaveLength(0);
  });
});

describe('refusals create nothing (REQ-040)', () => {
  const expectRefused = async (promise, code, status) => {
    const error = await reject(promise);
    expect(error).toMatchObject({ code, ...(status ? { statusCode: status } : {}) });
    expect(openRows().filter((r) => String(r.createdBy) === String(staffId))).toHaveLength(0);
    expect(await fakes.flushMail()).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalled();
  };

  it('an unknown customer, a customer without an account and one with a locked account → 404 CUSTOMER_NOT_FOUND', async () => {
    const stranger = fakes.addCustomer();
    const locked = fakes.addCustomer(); fakes.addUser({ customer: locked._id, roleName: 'CUSTOMER', isActive: false });
    await expectRefused(book({ customerId: new mongoose.Types.ObjectId() }), 'CUSTOMER_NOT_FOUND', 404);
    await expectRefused(book({ customerId: stranger._id }), 'CUSTOMER_NOT_FOUND', 404);
    await expectRefused(book({ customerId: locked._id }), 'CUSTOMER_NOT_FOUND', 404);
  });

  it('a car that is not for sale → 404 (MSG61, the same answer as for a customer\'s booking)', async () => {
    const sold = fakes.addCar({ status: 'SOLD' });
    await expectRefused(book({ carIds: [String(sold._id)] }), 'NOT_FOUND', 404);
  });

  it('the customer already has 2 open visits → 422 LIMIT; a visit at the same slot → 409 DUPLICATE', async () => {
    const mine = (when) => fakes.addAppointment({ customer: customer._id, car: fakes.addCar()._id, scheduledAt: when });
    mine(OTHER_SLOT); mine(new Date('2026-11-12T03:00:00Z'));
    await expectRefused(book(), 'APPOINTMENT_LIMIT_REACHED', 422);
    fakes.appointments.pop();
    mine(SLOT);
    await expectRefused(book(), 'APPOINTMENT_DUPLICATE', 409);
  });

  it('a full slot → 409 CAPACITY_FULL; a car held by somebody else → 409 CONFLICT naming it', async () => {
    const held = fakes.addCar();
    const [x, y] = [fakes.addCustomer(), fakes.addCustomer()];
    fakes.addAppointment({ customer: x._id, car: held._id, scheduledAt: SLOT });
    await expectRefused(book({ carIds: [String(held._id)] }), 'APPOINTMENT_CONFLICT', 409);
    fakes.addAppointment({ customer: y._id, car: fakes.addCar()._id, scheduledAt: SLOT });
    await expectRefused(book(), 'APPOINTMENT_CAPACITY_FULL', 409);
  });

  it('staff cannot overbook a slot: the capacity of 2 customers holds for them too', async () => {
    const [x, y] = [fakes.addCustomer(), fakes.addCustomer()];
    fakes.addAppointment({ customer: x._id, car: fakes.addCar()._id, scheduledAt: SLOT });
    fakes.addAppointment({ customer: y._id, car: fakes.addCar()._id, scheduledAt: SLOT });
    expect((await reject(book())).code).toBe('APPOINTMENT_CAPACITY_FULL');
  });
});

describe('the customer stays in control (REQ-041, INV-13)', () => {
  it('sees the visit in their own list and can cancel it; the cancellation counts as the customer\'s', async () => {
    const visit = await book();
    const mine = await getMyVisit({ customerId: customer._id, id: visit.visitId, now: NOW });
    expect(mine).toMatchObject({ status: 'CONFIRMED', visitCode: visit.visitCode });
    expect(JSON.stringify(mine)).not.toMatch(/Lan Sales|confirmedBy|assignedTo/);

    const customerUser = new mongoose.Types.ObjectId();
    const cancelled = await cancelMyVisit({ customerId: customer._id, userId: customerUser, id: visit.visitId, reason: 'đổi ý', now: NOW });
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancellationType: 'CUSTOMER', cancellationReason: 'đổi ý' });
  });
});

describe('racing the customer\'s own booking', () => {
  it('staff and the customer take the same car at the same slot: never both', async () => {
    const car = fakes.addCar();
    const barrier = (() => {
      let waiting = [];
      const releaseAll = () => { waiting.forEach((release) => release()); waiting = []; };
      return async ({ method, phase }) => {
        if (method !== 'create' || phase !== 'before') return;
        await new Promise((resolve) => {
          waiting.push(resolve);
          if (waiting.length >= 2) releaseAll(); else setTimeout(releaseAll, 150);
        });
      };
    })();
    fakes.hook = barrier;
    const other = fakes.addCustomer();
    const results = await Promise.allSettled([
      createVisitForCustomer({ userId: staffId, customerId: customer._id, carIds: [String(car._id)], scheduledAt: SLOT, now: NOW }),
      createVisit({ userId: new mongoose.Types.ObjectId(), customerId: other._id, carIds: [String(car._id)], scheduledAt: SLOT, now: NOW }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
    expect(openRows().filter((r) => String(r.car) === String(car._id))).toHaveLength(results.some((r) => r.status === 'fulfilled') ? 1 : 0);
  });
});
