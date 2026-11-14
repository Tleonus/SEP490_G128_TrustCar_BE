/**
 * @file appointment-validation.test.js
 * @description Strict input validation of the booking routes: 422 and zero queries.
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
];
const STAFF_ENDPOINTS = [
  ['get', '/appointments'],
  ['get', `/appointments/${oid()}`],
  ['patch', `/appointments/${oid()}/status`],
];

describe('strict validation: 422 and zero queries (REQ-004, AC-02)', () => {
  const car = oid();
  const good = { carIds: [car], scheduledAt: '2026-11-10T10:00:00+07:00' };
  const bodies = {
    'empty carIds': { ...good, carIds: [] },
    'four cars': { ...good, carIds: [oid(), oid(), oid(), oid()] },
    'same car twice': { ...good, carIds: [car, car.toUpperCase()] },
    'garbage id': { ...good, carIds: ['nope'] },
    'missing scheduledAt': { carIds: [car] },
    'scheduledAt without time zone': { ...good, scheduledAt: '2026-11-10T10:00:00' },
    'impossible date': { ...good, scheduledAt: '2026-13-45T10:00:00+07:00' },
    'unknown field': { ...good, status: 'CONFIRMED' },
    'notes too long': { ...good, notes: 'x'.repeat(501) },
  };

  test.each(Object.keys(bodies))('POST: %s', async (name) => {
    const res = await send('post', '/customer/appointments', await customerToken(), bodies[name]);
    expect([res.status, res.body.code]).toEqual([422, 'VALIDATION_ERROR']);
    expect(fakes.calls).toHaveLength(0);
  });

  test.each([
    '/customer/appointments/slots',
    `/customer/appointments/slots?carIds=${oid()}&from=2026-11-10`,
    `/customer/appointments/slots?carIds=${oid()},${oid()},${oid()},${oid()}&from=2026-11-10&to=2026-11-11`,
    `/customer/appointments/slots?carIds=nope&from=2026-11-10&to=2026-11-11`,
    `/customer/appointments/slots?carIds=${oid()}&from=2026-11-10&to=2026-11-11&extra=1`,
    '/customer/appointments?status=BOGUS',
    '/customer/appointments?unknown=1',
    '/customer/appointments/not-an-id',
  ])('GET %s', async (url) => {
    const res = await send('get', url, await customerToken());
    expect(res.status).toBe(422);
    expect(fakes.calls).toHaveLength(0);
  });

  test.each([
    ['no body', {}],
    ['no time zone', { scheduledAt: '2026-11-10T10:00:00' }],
    ['impossible date', { scheduledAt: '2026-13-45T10:00:00+07:00' }],
    ['unknown field', { scheduledAt: '2026-11-10T10:00:00+07:00', status: 'CONFIRMED' }],
    ['not a string', { scheduledAt: 12345 }],
  ])('reschedule (1.1.0): %s → 422 and zero queries', async (_name, body) => {
    const staff = await tokenFor({ roleName: 'SALES_STAFF' });
    expect((await send('patch', `/customer/appointments/${oid()}/reschedule`, await customerToken(), body)).status).toBe(422);
    expect((await send('patch', `/appointments/${oid()}/reschedule`, staff, body)).status).toBe(422);
    expect(fakes.calls).toHaveLength(0);
  });

  test('1.1.0 staff endpoints reject bad input with 422 and zero queries', async () => {
    const staff = await tokenFor({ roleName: 'SALES_STAFF' });
    const good = { customerId: oid(), carIds: [oid()], scheduledAt: '2026-11-10T10:00:00+07:00' };
    const bad = [
      ['get', '/appointments/customers'],
      ['get', '/appointments/customers?q=ab'],
      ['get', `/appointments/customers?q=${'x'.repeat(61)}`],
      ['get', '/appointments/customers?q=abc&extra=1'],
      ['get', '/appointments/slots?from=2026-11-10'],
      ['get', '/appointments/slots?from=2026-11-10&to=2026-11-11&carIds=nope'],
      ['get', '/appointments/slots?from=2026-11-10&to=2026-11-11&excludeVisitId=nope'],
      ['get', '/appointments?needsOutcome=maybe'],
      ['get', '/appointments?needsReminderCall=1x'],
      ['post', '/appointments', {}],
      ['post', '/appointments', { ...good, customerId: 'nope' }],
      ['post', '/appointments', { ...good, carIds: [] }],
      ['post', '/appointments', { ...good, carIds: [oid(), oid(), oid(), oid()] }],
      ['post', '/appointments', { ...good, scheduledAt: '2026-11-10T10:00:00' }],
      ['post', '/appointments', { ...good, status: 'CONFIRMED' }],
      ['post', '/appointments', { ...good, notes: 'x'.repeat(501) }],
      ['patch', `/appointments/${oid()}/status`, { status: 'CONFIRMED', reasonCode: 'SHOWROOM_BUSY' }],
      ['patch', `/appointments/${oid()}/status`, { status: 'CANCELLED', reasonCode: 'NOPE', reason: 'x' }],
    ];
    for (const [method, url, body] of bad) {
      const res = await send(method, url, staff, body);
      expect([url, res.status]).toEqual([url, 422]);
    }
    expect(fakes.calls).toHaveLength(0);
  });

  test('customer slots: excludeVisitId must be an id', async () => {
    const res = await send('get', `/customer/appointments/slots?carIds=${oid()}&from=2026-11-10&to=2026-11-11&excludeVisitId=nope`, await customerToken());
    expect(res.status).toBe(422);
    expect(fakes.calls).toHaveLength(0);
  });

  test('staff: bad status, unknown field and bad query are rejected', async () => {
    const staff = await tokenFor({ roleName: 'SALES_STAFF' });
    expect((await send('patch', `/appointments/${oid()}/status`, staff, { status: 'PENDING' })).status).toBe(422);
    expect((await send('patch', `/appointments/${oid()}/status`, staff, { status: 'CONFIRMED', note: 'x' })).status).toBe(422);
    expect((await send('get', '/appointments?cancellationType=ALIEN', staff)).status).toBe(422);
    expect((await send('get', '/appointments/nope', staff)).status).toBe(422);
    expect(fakes.calls).toHaveLength(0);
  });
});

