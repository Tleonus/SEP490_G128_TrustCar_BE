/**
 * @file rate-limiters.test.js
 * @description API rate limits: per-account quotas by role, per-IP quota for
 * anonymous callers, and the routes that must keep working at the limit.
 * Runs on a small Express app with low limits, so no MongoDB is involved.
 */

import express from 'express';
import jwt from 'jsonwebtoken';
import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
const { default: realApp } = await import('../src/app.js');
const { signAccessToken, signRefreshToken } = await import('../src/utils/authTokens.js');
const { default: User } = await import('../src/models/User.js');
const {
  createAuthLimiter, createGlobalLimiter, identifyCaller, limitsFromEnv, resolveLimit,
} = await import('../src/middlewares/rateLimiters.js');

const LIMITS = { ip: 3, customer: 2, staff: 4 };
const AUTH_MAX = 2;
const LOGOUT = '/api/v1/auth/logout';
const ME = '/api/v1/auth/me';
const LOGIN = '/api/v1/auth/login';
const CARS = '/api/v1/public/cars';

const buildApp = () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api/', identifyCaller, createGlobalLimiter(LIMITS));
  app.use('/api/v1/auth/', createAuthLimiter(AUTH_MAX));
  app.all('*', (_req, res) => res.status(200).json({ success: true }));
  return app;
};

let nextId = 0;
const tokenFor = (roleName) => {
  nextId += 1;
  return signAccessToken({ _id: String(nextId).padStart(24, '0'), email: `u${nextId}@trustcar.vn`, roleName, tokenVersion: 0 });
};
const forgedToken = () => {
  nextId += 1;
  return jwt.sign({ userId: String(nextId), roleName: 'ADMIN', type: 'access', tv: 0 }, 'not-the-server-secret');
};

let app;
let nextIp = 0;
let ip;
beforeEach(() => {
  app = buildApp();
  nextIp += 1;
  ip = `10.0.0.${nextIp}`;
});

const call = (method, path, { token, from = ip } = {}) => {
  const req = request(app)[method](path).set('X-Forwarded-For', from);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};
const get = (path, options) => call('get', path, options);
const post = (path, options) => call('post', path, options);

/** Sends `count` requests one after another and returns their status codes. */
const statuses = async (send, count) => {
  const codes = [];
  for (let i = 0; i < count; i += 1) codes.push((await send()).status);
  return codes;
};

describe('quota per account', () => {
  test('an account at its limit does not affect another account or an anonymous caller on the same IP', async () => {
    const heavy = tokenFor('CUSTOMER');
    await statuses(() => get(CARS, { token: heavy }), LIMITS.customer);

    await get(CARS, { token: heavy }).expect(429);
    await get(CARS, { token: tokenFor('CUSTOMER') }).expect(200);
    await get(CARS).expect(200);
  });

  test('one account keeps a single quota across different IPs', async () => {
    const token = tokenFor('CUSTOMER');
    await get(CARS, { token, from: '10.1.0.1' }).expect(200);
    await get(CARS, { token, from: '10.1.0.2' }).expect(200);
    await get(CARS, { token, from: '10.1.0.3' }).expect(429);
  });

  test('a customer stops exactly at the customer limit', async () => {
    const token = tokenFor('CUSTOMER');
    expect(await statuses(() => get(CARS, { token }), LIMITS.customer + 1)).toEqual([200, 200, 429]);
  });

  test.each(['SALES_STAFF', 'INSPECTOR', 'ADMIN'])('%s stops exactly at the staff limit', async (role) => {
    const token = tokenFor(role);
    expect(await statuses(() => get(CARS, { token }), LIMITS.staff + 1)).toEqual([200, 200, 200, 200, 429]);
  });
});

describe('quota per IP', () => {
  test('an anonymous caller stops at the IP limit with the existing error shape', async () => {
    expect(await statuses(() => get(CARS), LIMITS.ip)).toEqual([200, 200, 200]);
    const res = await get(CARS).expect(429);
    expect(res.body).toMatchObject({ success: false, code: 'RATE_LIMIT_EXCEEDED' });
    expect(res.body.message).not.toMatch(/IP/);
  });

  test('other IPs keep their own quota', async () => {
    await statuses(() => get(CARS), LIMITS.ip + 1);
    await get(CARS, { from: '10.2.0.1' }).expect(200);
  });

  test('forged tokens share the IP quota, so changing token does not help', async () => {
    const codes = await statuses(() => get(CARS, { token: forgedToken() }), LIMITS.ip + 1);
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  test('a refresh token counts as anonymous', async () => {
    const refresh = signRefreshToken({ _id: '0'.repeat(24), tokenVersion: 0 });
    expect(await statuses(() => get(CARS, { token: refresh }), LIMITS.ip + 1)).toEqual([200, 200, 200, 429]);
  });

  test('an expired token counts as anonymous', async () => {
    process.env.JWT_ACCESS_EXPIRES_IN = '-1s';
    const expired = tokenFor('ADMIN');
    delete process.env.JWT_ACCESS_EXPIRES_IN;
    expect(await statuses(() => get(CARS, { token: expired }), LIMITS.ip + 1)).toEqual([200, 200, 200, 429]);
  });
});

describe('configuration', () => {
  test.each([
    ['abc'], ['0'], ['-5'], ['12abc'], ['1.5'], [''], [undefined], ['0x10'], ['1e3'], ['99999999999999999999'],
  ])('%p falls back to the default', (value) => {
    expect(resolveLimit(value, 77)).toBe(77);
  });

  test('a positive whole number is used', () => {
    expect(resolveLimit('250', 77)).toBe(250);
  });

  test('defaults and environment overrides', () => {
    expect(limitsFromEnv({})).toEqual({ ip: 1000, customer: 600, staff: 2000 });
    expect(limitsFromEnv({ RATE_LIMIT_MAX: '5', RATE_LIMIT_CUSTOMER_MAX: '6', RATE_LIMIT_STAFF_MAX: '7' }))
      .toEqual({ ip: 5, customer: 6, staff: 7 });
  });
});

describe('routes that keep working at the limit', () => {
  test('logout with a valid token works after both limits are reached', async () => {
    const token = tokenFor('CUSTOMER');
    await statuses(() => get(CARS, { token }), LIMITS.customer + 1);
    await statuses(() => post(LOGIN), AUTH_MAX + 1);

    await post(LOGOUT, { token }).expect(200);
  });

  test('logout with a valid token uses up neither quota', async () => {
    const token = tokenFor('CUSTOMER');
    await statuses(() => post(LOGOUT, { token }), LIMITS.customer + AUTH_MAX + 1);

    await get(CARS, { token }).expect(200);
    await post(LOGIN).expect(200);
  });

  test('profile with a valid token skips the auth limit, while login stays blocked', async () => {
    const token = tokenFor('CUSTOMER');
    await statuses(() => post(LOGIN), AUTH_MAX);

    await get(ME, { token }).expect(200);
    const blocked = await post(LOGIN).expect(429);
    expect(blocked.body.code).toBe('AUTH_RATE_LIMIT');
  });

  test('profile still counts toward the account quota', async () => {
    const token = tokenFor('CUSTOMER');
    expect(await statuses(() => get(ME, { token }), LIMITS.customer + 1)).toEqual([200, 200, 429]);
  });

  test('a valid token does not widen the auth limit on other auth routes', async () => {
    const codes = await statuses(() => post(LOGIN, { token: tokenFor('ADMIN') }), AUTH_MAX + 1);
    expect(codes).toEqual([200, 200, 429]);
  });

  test.each([[LOGOUT, 'post'], [ME, 'get']])('%s with a forged token counts toward the auth limit', async (path, method) => {
    const codes = await statuses(() => call(method, path, { token: forgedToken() }), AUTH_MAX + 1);
    expect(codes).toEqual([200, 200, 429]);
  });
});

describe('response and cost', () => {
  test('responses under the limit carry RateLimit headers', async () => {
    const res = await get(CARS, { token: tokenFor('CUSTOMER') }).expect(200);
    expect(res.headers['ratelimit-limit']).toBe(String(LIMITS.customer));
    expect(res.headers['ratelimit-remaining']).toBe(String(LIMITS.customer - 1));
    expect(res.headers).toHaveProperty('ratelimit-reset');
  });

  test('a 429 tells the client when it can try again', async () => {
    const token = tokenFor('CUSTOMER');
    await statuses(() => get(CARS, { token }), LIMITS.customer);
    const res = await get(CARS, { token }).expect(429);
    expect(res.headers['ratelimit-remaining']).toBe('0');
    expect(res.headers).toHaveProperty('ratelimit-reset');
    expect(res.headers).toHaveProperty('retry-after');
  });

  test('identifying the caller does not touch the database', async () => {
    User.findById.mockClear(); // the harness already spies on it
    await get(CARS, { token: tokenFor('CUSTOMER') }).expect(200);
    expect(User.findById).not.toHaveBeenCalled();
  });
});

describe('wired into the real app', () => {
  const signIn = async (roleName) => {
    const user = await h.createUser({ roleName, email: `wired-${roleName.toLowerCase()}@trustcar.vn` });
    return signAccessToken({ _id: user.id, email: user.email, roleName, tokenVersion: 0 });
  };

  test('each kind of caller gets its own quota', async () => {
    const limits = limitsFromEnv();
    const limitFor = async (token) => {
      const req = request(realApp).get(ME);
      const res = await (token ? req.set('Authorization', `Bearer ${token}`) : req);
      return res.headers['ratelimit-limit'];
    };
    expect(await limitFor(await signIn('SALES_STAFF'))).toBe(String(limits.staff));
    expect(await limitFor(await signIn('CUSTOMER'))).toBe(String(limits.customer));
    expect(await limitFor(forgedToken())).toBe('30'); // /auth routes report the auth limit

    const anonymous = await request(realApp).get('/api/v1/health');
    expect(anonymous.headers['ratelimit-limit']).toBe(String(limits.ip));
  });

  // Express routes these spellings to the auth handlers, so they must count too.
  test.each([
    ['/api/v1//auth/login', '10.3.0.1'],
    ['/api/v1///auth/login', '10.3.0.2'],
    ['/API/V1/AUTH/login', '10.3.0.3'],
    ['/api/v1/auth//login', '10.3.0.4'],
  ])('%s counts toward the auth limit', async (path, from) => {
    let last;
    for (let i = 0; i < 31; i += 1) last = await request(realApp).post(path).set('X-Forwarded-For', from).send({});
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('AUTH_RATE_LIMIT');
  });

  test('after the auth limit, login is blocked but profile and logout still work', async () => {
    const token = await signIn('ADMIN');
    const login = () => request(realApp).post(LOGIN).send({});
    let last;
    for (let i = 0; i < 31; i += 1) last = await login();
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('AUTH_RATE_LIMIT');

    await request(realApp).get(ME).set('Authorization', `Bearer ${token}`).expect(200);
    await request(realApp).post(LOGOUT).set('Authorization', `Bearer ${token}`).expect(200);
  });
});
