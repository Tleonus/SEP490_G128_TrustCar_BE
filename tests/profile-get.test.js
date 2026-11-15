/**
 * @file profile-get.test.js
 * @description GET /profile: the DTO for a customer and for staff, nothing internal leaks, and a
 * customer whose Customer record is missing gets 404.
 *
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-002
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-003
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-015
 */

import { setupAuthHarness } from './helpers/fakeAuthModels.js';
import { makeCaller, makeCustomer, makeStaff } from './helpers/profileFixtures.js';

const h = await setupAuthHarness();
const call = makeCaller(h);
beforeEach(() => h.reset());

const FORBIDDEN = [
  'password', 'tokenVersion', 'firebaseUid', 'avatar', 'notes', 'source', 'createdBy', 'updatedBy',
  'isActive', 'failedLoginAttempts', 'lockUntil', 'customer', 'refreshToken',
];

describe('a customer (AC-03)', () => {
  const setup = () => makeCustomer(h, {
    fullName: 'Nguyễn An', phone: '0901234567',
    customer: {
      address: { street: '1 Lê Lợi', city: 'Huế' }, dateOfBirth: new Date('2000-05-20T00:00:00Z'), gender: 'MALE',
      notes: 'khách khó tính', source: 'WALK_IN', marketingConsent: true,
    },
  });

  test('gets the contact fields, the extended fields and all five editable fields', async () => {
    const { token, id, email } = await setup();
    const res = await call('get', '/api/v1/profile', token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(res.body.data).toMatchObject({
      id, email, role: 'CUSTOMER', fullName: 'Nguyễn An', phone: '0901234567',
      address: { street: '1 Lê Lợi', district: null, city: 'Huế', province: null },
      dateOfBirth: '2000-05-20', gender: 'MALE',
      editableFields: ['fullName', 'phone', 'address', 'dateOfBirth', 'gender'],
    });
  });

  test('never returns an internal field, even though the stored records have them', async () => {
    const { token, id, customerId } = await setup();
    expect(h.customers.get(customerId).notes).toBe('khách khó tính'); // really stored
    expect(h.stored(id).password).toBeDefined();
    const res = await call('get', '/api/v1/profile', token);
    const json = JSON.stringify(res.body);
    FORBIDDEN.forEach((key) => expect(json).not.toContain(`"${key}"`));
    expect(json).not.toMatch(/\$2[aby]\$|khách khó tính|WALK_IN/);
  });

  test('a customer who never filled the extras gets nulls, not missing keys', async () => {
    const { token } = await makeCustomer(h);
    const { data } = (await call('get', '/api/v1/profile', token)).body;
    expect(data.address).toEqual({ street: null, district: null, city: null, province: null });
    expect(data.dateOfBirth).toBeNull();
    expect(data.gender).toBeNull();
  });

  test('the date of birth comes back exactly as stored, whatever the server time zone', async () => {
    const { token } = await makeCustomer(h, { customer: { dateOfBirth: new Date('1999-12-31T00:00:00Z') } });
    expect((await call('get', '/api/v1/profile', token)).body.data.dateOfBirth).toBe('1999-12-31');
  });
});

describe('staff (AC-04)', () => {
  test.each(['SALES_STAFF', 'ADMIN'])('%s: extras are null and only name and phone are editable', async (role) => {
    const { token } = await makeStaff(h, role);
    const res = await call('get', '/api/v1/profile', token);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      role, fullName: 'Lan Sales', phone: '0911000111', address: null, dateOfBirth: null, gender: null, editableFields: ['fullName', 'phone'],
    });
    FORBIDDEN.forEach((key) => expect(JSON.stringify(res.body)).not.toContain(`"${key}"`));
  });
});

describe('a customer without a Customer record (AC-22)', () => {
  test('GET /profile → 404 CUSTOMER_NOT_FOUND', async () => {
    const { token, customerId } = await makeCustomer(h);
    h.customers.delete(customerId); // the linked record disappeared
    const res = await call('get', '/api/v1/profile', token);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
  });

  test('a customer account that was never linked → 404 as well', async () => {
    const { token, id } = await makeCustomer(h);
    delete h.stored(id).customer;
    expect((await call('get', '/api/v1/profile', token)).status).toBe(404);
  });
});

describe('response shape', () => {
  test('uses the standard envelope', async () => {
    const { token } = await makeCustomer(h);
    const res = await call('get', '/api/v1/profile', token);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'message', 'success']);
  });
});
