/**
 * @file car-compare-public.test.js
 * @description GET /api/v1/public/cars/compare – anyone (guest, customer, staff, admin) may compare
 * 2–3 vehicles without logging in; input validation still applies and nothing internal leaks.
 *
 * Runs the real app on the in-memory auth harness (no MongoDB). `Car.find` is a recorder.
 * The logged-in route (/customer/cars/compare, covered by car-compare-access.test.js) is unchanged.
 */

import mongoose from 'mongoose';
import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
// Loaded after the harness on purpose (see car-compare-access.test.js).
const { jest } = await import('@jest/globals');
const { signAccessToken } = await import('../src/utils/authTokens.js');
const { default: Car } = await import('../src/models/Car.js');

const URL = '/api/v1/public/cars/compare';
const oid = () => new mongoose.Types.ObjectId().toString();

let findCalls = [];
const carsFor = (ids) => ids.map((id) => ({ _id: id, make: 'MAZDA', price: 500_000_000, floorPrice: 9, originalPrice: 9, vin: 'SECRETVIN' }));
jest.spyOn(Car, 'find').mockImplementation((filter) => {
  findCalls.push(filter);
  const ids = (filter?._id?.$in ?? []).map(String);
  return { lean: async () => carsFor(ids) };
});

const tokenFor = async (overrides) => {
  const { id } = await h.createUser(overrides);
  return signAccessToken(await h.User.findById(id).select('+tokenVersion'));
};
const call = (query, token) => {
  const req = request(h.app).get(`${URL}${query}`).set('X-Forwarded-For', h.nextIp());
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

beforeEach(() => {
  h.reset();
  findCalls = [];
});

describe('open to everyone, no login needed', () => {
  test('a guest (no token) gets the comparison → 200, 2 cars in the requested order', async () => {
    const [a, b] = [oid(), oid()];
    const res = await call(`?ids=${a},${b}`);

    expect(res.status).toBe(200);
    expect(res.body.data.cars.map((car) => car._id)).toEqual([a, b]);
    expect(findCalls).toHaveLength(1);
  });

  test('3 cars are allowed', async () => {
    const ids = [oid(), oid(), oid()];
    const res = await call(`?ids=${ids.join(',')}`);

    expect(res.status).toBe(200);
    expect(res.body.data.cars).toHaveLength(3);
  });

  test('a garbage token is simply ignored on this public route → 200', async () => {
    const res = await call(`?ids=${oid()},${oid()}`, 'garbage');

    expect(res.status).toBe(200);
  });

  test.each([
    ['CUSTOMER', { roleName: 'CUSTOMER', phone: '0901234567' }],
    ['SALES_STAFF', { roleName: 'SALES_STAFF' }],
    ['ADMIN', { roleName: 'ADMIN' }],
  ])('%s may compare too → 200', async (_name, overrides) => {
    const res = await call(`?ids=${oid()},${oid()}`, await tokenFor(overrides));

    expect(res.status).toBe(200);
    expect(res.body.data.cars).toHaveLength(2);
  });

  test('internal inventory data never reaches a guest', async () => {
    const res = await call(`?ids=${oid()},${oid()}`);

    expect(JSON.stringify(res.body)).not.toMatch(/floorPrice|originalPrice|SECRETVIN|vin/i);
  });

  test('only publicly available vehicles are queried', async () => {
    await call(`?ids=${oid()},${oid()}`);

    expect(JSON.stringify(findCalls[0])).toMatch(/AVAILABLE/);
  });
});

describe('input validation still applies (no Car query is made)', () => {
  const bad = {
    'one id': () => oid(),
    'four ids': () => [oid(), oid(), oid(), oid()].join(','),
    'same id twice': () => { const x = oid(); return `${x},${x}`; },
    'not hex': () => `${oid()},abc`,
    'empty item': () => `${oid()},,${oid()}`,
    'empty': () => '',
  };

  test.each(Object.keys(bad))('%s → 422 VALIDATION_ERROR', async (name) => {
    const res = await call(`?ids=${bad[name]()}`);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.errors[0].field).toBe('ids');
    expect(findCalls).toHaveLength(0);
  });

  test('missing ids parameter → 422 (and "compare" is not mistaken for a car id)', async () => {
    const res = await call('');

    expect(res.status).toBe(422);
    expect(findCalls).toHaveLength(0);
  });
});

describe('POST /api/v1/public/cars/compare/ai-insight (On-Demand AI recommendation)', () => {
  const postAi = (body) =>
    request(h.app)
      .post(`${URL}/ai-insight`)
      .set('X-Forwarded-For', h.nextIp())
      .send(body);

  test('returns grounded comparison insight with AI warning disclaimer and no internal fields', async () => {
    delete process.env.CHAT_LLM_API_KEY;
    delete process.env.CAPTION_LLM_API_KEY;

    const [a, b] = [oid(), oid()];
    const res = await postAi({ ids: [a, b], preference: 'economy' });

    expect(res.status).toBe(200);
    expect(res.body.data.preference).toBe('economy');
    expect(res.body.data.summary).toEqual(expect.any(String));
    expect(res.body.data.recommendation).toEqual(expect.any(String));
    expect(res.body.data.carInsights).toHaveLength(2);
    expect(res.body.data.disclaimer).toMatch(/AI có thể sai/i);
    expect(JSON.stringify(res.body)).not.toMatch(/floorPrice|originalPrice|SECRETVIN/i);
    expect(JSON.stringify(res.body)).not.toMatch(/% phù hợp/i);
  });

  test('rejects invalid ids or unsupported preference → 422 VALIDATION_ERROR', async () => {
    const resTooFew = await postAi({ ids: [oid()] });
    expect(resTooFew.status).toBe(422);

    const resBadPref = await postAi({ ids: [oid(), oid()], preference: 'invalid_pref' });
    expect(resBadPref.status).toBe(422);
  });
});
