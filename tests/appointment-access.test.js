/**
 * @file appointment-access.test.js
 * @description HTTP layer of test-drive booking on the real Express app (in-memory
 * models): who may call what (401/403 with zero queries), strict input validation
 * (422 with zero queries), one end-to-end customer + staff flow, error safety.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-001, 002, 004, 024, 026; AC-02, AC-22)
 */

import mongoose from 'mongoose';
import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
// Loaded after the harness on purpose (see car-compare-access.test.js).
const { jest } = await import('@jest/globals');
const { setupAppointmentFakes } = await import('./helpers/fakeAppointmentModels.js');
const { signAccessToken } = await import('../src/utils/authTokens.js');
const { vnDateKey } = await import('../src/services/appointmentSlotRules.js');
const fakes = await setupAppointmentFakes();

const API = '/api/v1';
const oid = () => String(new mongoose.Types.ObjectId());
const slotAt = (daysAhead, hhmm = '10:00') => `${vnDateKey(new Date(Date.now() + daysAhead * 86400e3))}T${hhmm}:00+07:00`;

let phone = 0;
const tokenFor = async (overrides) => {
  phone += 1;
  const { id } = await h.createUser({ phone: `09012345${String(phone).padStart(2, '0')}`, ...overrides });
  return signAccessToken(await h.User.findById(id).select('+tokenVersion'));
};
/** A complete CUSTOMER account linked to a Customer record. */
const customerToken = async () => tokenFor({ roleName: 'CUSTOMER', customer: fakes.addCustomer()._id });
const send = (method, url, token, body) => {
  const req = request(h.app)[method](`${API}${url}`).set('X-Forwarded-For', h.nextIp());
  if (token) req.set('Authorization', `Bearer ${token}`);
  return body === undefined ? req : req.send(body);
};

beforeEach(() => { h.reset(); fakes.reset(); });

const CUSTOMER_ENDPOINTS = [
  ['get', '/customer/appointments/slots?carIds=a&from=2026-11-10&to=2026-11-11'],
  ['post', '/customer/appointments'],
  ['get', '/customer/appointments'],
  ['get', `/customer/appointments/${oid()}`],
  ['patch', `/customer/appointments/${oid()}/cancel`],
  ['patch', `/customer/appointments/${oid()}/reschedule`],
];
const STAFF_ENDPOINTS = [
  ['get', '/appointments'],
  ['get', `/appointments/${oid()}`],
  ['patch', `/appointments/${oid()}/status`],
  ['patch', `/appointments/${oid()}/reschedule`],
  ['get', '/appointments/slots?from=2026-11-10&to=2026-11-11'],
  ['get', '/appointments/customers?q=abc'],
  ['post', '/appointments'],
];

describe('authentication and authorisation (REQ-001, 002; AC-22)', () => {
  test.each(CUSTOMER_ENDPOINTS)('no token / garbage token → 401: %s %s', async (method, url) => {
    expect((await send(method, url)).status).toBe(401);
    expect((await send(method, url, 'garbage')).status).toBe(401);
    expect(fakes.calls).toHaveLength(0);
  });

  test.each(STAFF_ENDPOINTS)('no token / garbage token → 401: %s %s', async (method, url) => {
    expect((await send(method, url)).status).toBe(401);
    expect((await send(method, url, 'garbage')).status).toBe(401);
    expect(fakes.calls).toHaveLength(0);
  });

  test.each(['ADMIN', 'SALES_STAFF', 'INSPECTOR'])('%s on the customer API → 403 ROLE_INSUFFICIENT', async (roleName) => {
    const token = await tokenFor({ roleName });
    for (const [method, url] of CUSTOMER_ENDPOINTS) {
      const res = await send(method, url, token);
      expect([res.status, res.body.code]).toEqual([403, 'ROLE_INSUFFICIENT']);
    }
    expect(fakes.calls).toHaveLength(0);
  });

  test('a customer with an incomplete profile → 403 PROFILE_INCOMPLETE', async () => {
    const token = await tokenFor({ roleName: 'CUSTOMER', firebaseUid: `g-${Date.now()}`, password: null, fullName: undefined });
    const res = await send('get', '/customer/appointments', token);
    expect([res.status, res.body.code]).toEqual([403, 'PROFILE_INCOMPLETE']);
    expect(fakes.calls).toHaveLength(0);
  });

  test.each(['CUSTOMER', 'INSPECTOR'])('%s on the staff API → 403 and no appointment query', async (roleName) => {
    const token = roleName === 'CUSTOMER' ? await customerToken() : await tokenFor({ roleName });
    for (const [method, url] of STAFF_ENDPOINTS) {
      expect((await send(method, url, token, {})).status).toBe(403);
    }
    expect(fakes.calls).toHaveLength(0);
  });
});

describe('end-to-end flow', () => {
  test('customer books, lists, reads, sees the slot taken and cancels; staff handles it', async () => {
    const car = fakes.addCar();
    const token = await customerToken();
    const when = slotAt(3);

    const created = await send('post', '/customer/appointments', token, { carIds: [String(car._id)], scheduledAt: when, notes: 'Lái thử' });
    expect(created.status).toBe(201);
    const { visit } = created.body.data;
    expect(visit).toMatchObject({ status: 'PENDING', notes: 'Lái thử', appointments: [{ car: { _id: String(car._id) } }] });
    expect(JSON.stringify(created.body)).not.toMatch(/secret|VIN123|51A-000|internalNotes|publicId|floorPrice|assignedTo|createdBy/);

    const list = await send('get', '/customer/appointments', token);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta).toMatchObject({ total: 1, page: 1 });
    expect((await send('get', `/customer/appointments/${visit.appointments[0]._id}`, token)).body.data.visit.visitId).toBe(visit.visitId);

    const day = when.slice(0, 10);
    const slots = await send('get', `/customer/appointments/slots?carIds=${car._id}&from=${day}&to=${day}`, token);
    expect(slots.body.data.days[0].slots.find((s) => s.start === when)).toMatchObject({ available: false, reason: 'ALREADY_BOOKED' });

    const staff = await tokenFor({ roleName: 'SALES_STAFF' });
    const seen = await send('get', '/appointments', staff);
    expect(seen.body.data[0]).toMatchObject({ visitId: visit.visitId, appointments: [{ car: { status: 'AVAILABLE' } }] });
    const confirmed = await send('patch', `/appointments/${visit.visitId}/status`, staff, { status: 'CONFIRMED' });
    expect([confirmed.status, confirmed.body.data.visit.status]).toEqual([200, 'CONFIRMED']);

    const cancelled = await send('patch', `/customer/appointments/${visit.visitId}/cancel`, token, { reason: 'Bận' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.visit).toMatchObject({ status: 'CANCELLED', cancellationType: 'CUSTOMER', isLateCancellation: false });
    expect((await send('patch', `/customer/appointments/${visit.visitId}/cancel`, token, {})).body.code).toBe('APPOINTMENT_CANCELLED_ALREADY');
  });

  test('another customer cannot read or cancel my visit (404)', async () => {
    const car = fakes.addCar();
    const mine = await customerToken();
    const theirs = await customerToken();
    const created = await send('post', '/customer/appointments', mine, { carIds: [String(car._id)], scheduledAt: slotAt(3) });
    const id = created.body.data.visit.visitId;
    expect((await send('get', `/customer/appointments/${id}`, theirs)).body.code).toBe('APPOINTMENT_NOT_FOUND');
    expect((await send('patch', `/customer/appointments/${id}/cancel`, theirs, {})).status).toBe(404);
    expect((await send('get', '/customer/appointments', theirs)).body.data).toHaveLength(0);
  });

  test('ADMIN can handle visits too; cancelling needs a reason', async () => {
    const car = fakes.addCar();
    const owner = await customerToken();
    const created = await send('post', '/customer/appointments', owner, { carIds: [String(car._id)], scheduledAt: slotAt(3) });
    const id = created.body.data.visit.visitId;
    const admin = await tokenFor({ roleName: 'ADMIN' });
    expect((await send('patch', `/appointments/${id}/status`, admin, { status: 'CANCELLED' })).status).toBe(422);
    const res = await send('patch', `/appointments/${id}/status`, admin, { status: 'CANCELLED', reasonCode: 'SHOWROOM_BUSY', reason: 'Hết xe' });
    expect(res.body.data.visit).toMatchObject({
      status: 'CANCELLED', cancellationType: 'STAFF', cancellationReason: 'Showroom có việc đột xuất', cancellationNote: 'Hết xe',
    });
    // The customer sees the label only, never the staff member's note (AC-29).
    const mine = await send('get', `/customer/appointments/${id}`, owner);
    expect(mine.body.data.visit).toMatchObject({ cancellationType: 'STAFF', cancellationReason: 'Showroom có việc đột xuất' });
    expect(JSON.stringify(mine.body)).not.toMatch(/Hết xe|cancellationNote/);
  });
});

describe('1.1.0 end-to-end: reschedule, staff grid, book on behalf', () => {
  test('a customer moves a visit; staff see it on the grid, find the customer and book for them', async () => {
    const car = fakes.addCar();
    const customer = fakes.addCustomer({ fullName: 'Nguyễn An', phone: '0901000111', email: 'an@example.com' });
    const token = await tokenFor({ roleName: 'CUSTOMER', customer: customer._id });
    fakes.addUser({ customer: customer._id, roleName: 'CUSTOMER', isActive: true });
    const from = slotAt(4);
    const to = slotAt(5, '13:00');

    const created = await send('post', '/customer/appointments', token, { carIds: [String(car._id)], scheduledAt: from });
    const { visit } = created.body.data;
    expect(visit).toMatchObject({ rescheduleCount: 0, canReschedule: true });

    // The customer's grid while moving: their own slot is free again.
    const day = from.slice(0, 10);
    const moving = await send('get', `/customer/appointments/slots?carIds=${car._id}&from=${day}&to=${day}&excludeVisitId=${visit.visitId}`, token);
    expect(moving.body.data.days[0].slots.find((s) => s.start === from)).toMatchObject({ available: true });

    const moved = await send('patch', `/customer/appointments/${visit.visitId}/reschedule`, token, { scheduledAt: to });
    expect(moved.status).toBe(200);
    expect(moved.body.data.previousVisitCode).toBe(visit.visitCode);
    expect(moved.body.data.visit).toMatchObject({ status: 'PENDING', scheduledAt: new Date(to).toISOString(), rescheduleCount: 1, canReschedule: true });
    expect(moved.body.data.visit.visitCode).not.toBe(visit.visitCode);
    expect((await send('get', `/customer/appointments/${visit.visitId}`, token)).body.code).toBe('APPOINTMENT_NOT_FOUND');

    // Staff: who is booked where, and who can they book for?
    const staff = await tokenFor({ roleName: 'SALES_STAFF' });
    const toDay = to.slice(0, 10);
    const grid = await send('get', `/appointments/slots?from=${toDay}&to=${toDay}`, staff);
    const slot = grid.body.data.days[0].slots.find((s) => s.start === to);
    expect(slot).toMatchObject({ capacityRemaining: 1, visits: [{ customer: { fullName: 'Nguyễn An', phone: '0901000111' } }] });
    const found = await send('get', '/appointments/customers?q=nguyễn', staff);
    expect(found.body.data.customers).toEqual([{ _id: String(customer._id), fullName: 'Nguyễn An', phone: '0901000111', email: 'an@example.com' }]);

    const booked = await send('post', '/appointments', staff, { customerId: String(customer._id), carIds: [String(fakes.addCar()._id)], scheduledAt: slotAt(6) });
    expect(booked.status).toBe(201);
    expect(booked.body.data.visit).toMatchObject({ status: 'CONFIRMED', customer: { fullName: 'Nguyễn An' }, rescheduleCount: 0 });

    // Staff move the confirmed visit; it stays confirmed.
    const staffMoved = await send('patch', `/appointments/${booked.body.data.visit.visitId}/reschedule`, staff, { scheduledAt: slotAt(7, '15:00') });
    expect([staffMoved.status, staffMoved.body.data.visit.status]).toEqual([200, 'CONFIRMED']);

    // The reminder filter accepts a boolean and answers (nothing is within 30 minutes of now).
    const reminders = await send('get', '/appointments?needsReminderCall=true', staff);
    expect([reminders.status, reminders.body.data]).toEqual([200, []]);
    expect(await fakes.flushMail()).toHaveLength(4); // booked, moved, booked for, moved by staff
  });

  test('INSPECTOR and CUSTOMER cannot use the new staff endpoints', async () => {
    const inspector = await tokenFor({ roleName: 'INSPECTOR' });
    const customer = await customerToken();
    for (const token of [inspector, customer]) {
      expect((await send('get', '/appointments/customers?q=abc', token)).status).toBe(403);
      expect((await send('post', '/appointments', token, {})).status).toBe(403);
      expect((await send('get', '/appointments/slots?from=2026-11-10&to=2026-11-11', token)).status).toBe(403);
    }
  });
});

describe('error safety (REQ-026)', () => {
  test('an unexpected database error → 500 INTERNAL_ERROR without stack or internal detail', async () => {
    const token = await customerToken();
    const { default: Appointment } = await import('../src/models/Appointment.js');
    Appointment.find.mockImplementationOnce(() => { throw new Error('boom internal detail'); });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await send('get', '/customer/appointments', token);
      expect([res.status, res.body.code]).toEqual([500, 'INTERNAL_ERROR']);
      expect(res.body.stack).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/boom|internal detail/);
    } finally {
      process.env.NODE_ENV = previousEnv;
      consoleSpy.mockRestore();
    }
  });
});
