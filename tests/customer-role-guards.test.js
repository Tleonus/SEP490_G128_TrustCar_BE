/**
 * @file customer-role-guards.test.js
 * @description CUSTOMER role: no access to internal APIs, cannot be assigned or
 * converted through user management, and is seeded into existing databases.
 *
 * Runs the real app on the in-memory persistence harness (no MongoDB).
 */

import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
const { signAccessToken } = await import('../src/utils/authTokens.js');
const { default: Role } = await import('../src/models/Role.js');
const { Roles, ROLE_PERMISSIONS } = await import('../src/constants/appConstants.js');

const as = (token) => ({ Authorization: `Bearer ${token}`, 'X-Forwarded-For': h.nextIp() });

const tokenFor = async (overrides) => {
  const { id } = await h.createUser(overrides);
  const user = await h.User.findById(id).select('+tokenVersion');
  return { id, token: signAccessToken(user) };
};

beforeEach(() => h.reset());

describe('CUSTOMER role definition', () => {
  test('exists and carries no internal permissions', () => {
    expect(Roles.CUSTOMER).toBe('CUSTOMER');
    expect(ROLE_PERMISSIONS[Roles.CUSTOMER]).toEqual([]);
  });
});

// A customer with a complete profile, so the role check (not the profile gate) is exercised.
const completeCustomer = { roleName: 'CUSTOMER', phone: '0901234567' };

describe('AC-18 / REQ-026: customers cannot reach internal APIs', () => {
  test('GET /api/v1/users → 403', async () => {
    const { token } = await tokenFor(completeCustomer);
    const res = await request(h.app).get('/api/v1/users').set(as(token));
    expect(res.status).toBe(403);
  });

  test('GET /api/v1/manage/cars/featured → 403 (previously token-only)', async () => {
    const { token } = await tokenFor(completeCustomer);
    const res = await request(h.app).get('/api/v1/manage/cars/featured').set(as(token));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ROLE_INSUFFICIENT');
  });
});

describe('AC-18 / REQ-027: user management cannot create or convert customers', () => {
  test('Admin creating a CUSTOMER account → 422', async () => {
    const { token } = await tokenFor({ roleName: 'ADMIN' });
    const res = await request(h.app).post('/api/v1/users').set(as(token)).send({
      fullName: 'Khach Hang', email: 'kh@trustcar.vn', password: 'TrustCar2026', roleName: 'CUSTOMER',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('Admin changing a staff member to CUSTOMER → 422', async () => {
    const { token } = await tokenFor({ roleName: 'ADMIN' });
    const { id } = await h.createUser({ roleName: 'SALES_STAFF' });
    const res = await request(h.app).put(`/api/v1/users/${id}`).set(as(token)).send({ roleName: 'CUSTOMER' });
    expect(res.status).toBe(422);
    expect(h.stored(id).roleName).toBe('SALES_STAFF');
  });

  test('Admin changing a CUSTOMER into staff → 422', async () => {
    const { token } = await tokenFor({ roleName: 'ADMIN' });
    const { id } = await h.createUser({ roleName: 'CUSTOMER' });
    const res = await request(h.app).put(`/api/v1/users/${id}`).set(as(token)).send({ roleName: 'SALES_STAFF' });
    expect(res.status).toBe(422);
    expect(h.stored(id).roleName).toBe('CUSTOMER');
  });
});

describe('Role.seedDefaultRoles (idempotent, fills missing roles)', () => {
  const stubRoles = (existingNames) => {
    const inserted = [];
    const original = { find: Role.find, insertMany: Role.insertMany };
    Role.find = () => ({ lean: async () => existingNames.map((name) => ({ name })) });
    Role.insertMany = async (docs) => { inserted.push(...docs); return docs; };
    return { inserted, restore: () => Object.assign(Role, original) };
  };

  test('adds only CUSTOMER to a database already seeded with ADMIN and SALES_STAFF', async () => {
    const stub = stubRoles(['ADMIN', 'SALES_STAFF']);
    try {
      await Role.seedDefaultRoles();
      expect(stub.inserted.map((r) => r.name)).toEqual(['CUSTOMER']);
      expect(stub.inserted[0].permissions).toEqual([]);
    } finally { stub.restore(); }
  });

  test('inserts nothing when every default role exists', async () => {
    const stub = stubRoles(['ADMIN', 'SALES_STAFF', 'CUSTOMER']);
    try {
      await Role.seedDefaultRoles();
      expect(stub.inserted).toHaveLength(0);
    } finally { stub.restore(); }
  });

  test('seeds all roles into an empty database', async () => {
    const stub = stubRoles([]);
    try {
      await Role.seedDefaultRoles();
      expect(stub.inserted.map((r) => r.name).sort()).toEqual(['ADMIN', 'CUSTOMER', 'SALES_STAFF']);
    } finally { stub.restore(); }
  });
});
