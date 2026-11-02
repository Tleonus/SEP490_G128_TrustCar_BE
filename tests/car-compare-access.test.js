/**
 * @file car-compare-access.test.js
 * @description GET /api/v1/customer/cars/compare – who may call it, input validation
 * and error safety. Result content is covered by car-compare.test.js.
 *
 * Runs the real app on the in-memory auth harness (no MongoDB). `Car.find` is a
 * recorder: every rejected request must leave it untouched (NFR-03).
 *
 * Ref: .sdd/features/vehicle-comparison/SPEC.md (REQ-002, 003, 004, 007, 008, 014; AC-07…11)
 */

import mongoose from 'mongoose';
import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
// Loaded after the harness on purpose: importing it first would bind the harness's
// jest.unstable_mockModule paths to this file instead of tests/helpers.
const { jest } = await import('@jest/globals');
const { signAccessToken } = await import('../src/utils/authTokens.js');
const { default: Car } = await import('../src/models/Car.js');

const URL = '/api/v1/customer/cars/compare';
const oid = () => new mongoose.Types.ObjectId().toString();
const twoIds = () => `${oid()},${oid()}`;

let findCalls = [];
jest.spyOn(Car, 'find').mockImplementation((filter) => {
  findCalls.push(filter);
  return { lean: async () => [] };
});

const tokenFor = async (overrides) => {
  const { id } = await h.createUser(overrides);
  return signAccessToken(await h.User.findById(id).select('+tokenVersion'));
};
const customerToken = () => tokenFor({ roleName: 'CUSTOMER', phone: '0901234567' });
const call = (query, token) => {
  const req = request(h.app).get(`${URL}${query}`).set('X-Forwarded-For', h.nextIp());
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

beforeEach(() => {
  h.reset();
  findCalls = [];
});

describe('input validation (REQ-007, 008) – no Car query is made', () => {
  const bad = {
    'one id': () => oid(),
    'four ids': () => [oid(), oid(), oid(), oid()].join(','),
    'same id twice': () => { const x = oid(); return `${x},${x}`; },
    'not hex': () => `${oid()},abc`,
    'empty item': () => `${oid()},,${oid()}`,
    'too long': () => `${oid()},${'a'.repeat(200)}`,
    'empty': () => '',
  };

  test.each(Object.keys(bad))('AC-07 / AC-08: %s → 422 VALIDATION_ERROR', async (name) => {
    const res = await call(`?ids=${bad[name]()}`, await customerToken());

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.errors[0].field).toBe('ids');
    expect(findCalls).toHaveLength(0);
  });

  test('missing ids parameter → 422', async () => {
    const res = await call('', await customerToken());

    expect(res.status).toBe(422);
    expect(findCalls).toHaveLength(0);
  });
});

describe('authentication and authorization (REQ-002, 003, 004)', () => {
  test('AC-09: no token, garbage token and a revoked token → 401, no Car query', async () => {
    const token = await customerToken();
    await request(h.app).post('/api/v1/auth/logout').set('X-Forwarded-For', h.nextIp()).set('Authorization', `Bearer ${token}`);

    expect((await call(`?ids=${twoIds()}`)).status).toBe(401);
    expect((await call(`?ids=${twoIds()}`, 'garbage')).status).toBe(401);
    expect((await call(`?ids=${twoIds()}`, token)).status).toBe(401);
    expect(findCalls).toHaveLength(0);
  });

  test.each(['ADMIN', 'SALES_STAFF'])('AC-10: %s → 403 ROLE_INSUFFICIENT', async (roleName) => {
    const res = await call(`?ids=${twoIds()}`, await tokenFor({ roleName }));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ROLE_INSUFFICIENT');
    expect(findCalls).toHaveLength(0);
  });

  test('AC-11: customer with an incomplete profile → 403 PROFILE_INCOMPLETE', async () => {
    const token = await tokenFor({
      roleName: 'CUSTOMER', firebaseUid: `g-${Date.now()}`, password: null, fullName: undefined,
    });
    const res = await call(`?ids=${twoIds()}`, token);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PROFILE_INCOMPLETE');
    expect(findCalls).toHaveLength(0);
  });
});

describe('error safety (REQ-014)', () => {
  test('an unexpected database error → 500 INTERNAL_ERROR with no stack or internal message in production mode', async () => {
    const token = await customerToken();
    Car.find.mockImplementationOnce(() => { throw new Error('boom internal detail'); });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; // the shared error handler hides details only in production
    try {
      const res = await call(`?ids=${twoIds()}`, token);

      expect(res.status).toBe(500);
      expect(res.body.code).toBe('INTERNAL_ERROR');
      expect(res.body.stack).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/boom|internal detail/);
    } finally {
      process.env.NODE_ENV = previousEnv;
      consoleSpy.mockRestore();
    }
  });
});
