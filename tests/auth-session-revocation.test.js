/**
 * @file auth-session-revocation.test.js
 * @description Token typing and session revocation (tokenVersion) through the
 * real auth middleware, plus logout / revocation flows.
 *
 * Runs the real app on the in-memory persistence harness (no MongoDB).
 */

import { default as request } from 'supertest';
import jwt from 'jsonwebtoken';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
const { signAccessToken, signRefreshToken } = await import('../src/utils/authTokens.js');
const { optionalAuth } = await import('../src/middlewares/authMiddleware.js');

const get  = (url) => request(h.app).get(url).set('X-Forwarded-For', h.nextIp());

/** Signs tokens for a stored user exactly as the service would. */
const tokensFor = async (id) => {
  const user = await h.User.findById(id).select('+tokenVersion');
  return { access: signAccessToken(user), refresh: signRefreshToken(user) };
};

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

beforeEach(() => h.reset());

// ════════════════════════════════════════════════════════════════════════════
// verifyToken — REQ-006, REQ-010, REQ-011
// ════════════════════════════════════════════════════════════════════════════
describe('verifyToken on a protected route (GET /api/v1/auth/me)', () => {
  test('accepts a current access token and never exposes revocation data', async () => {
    const { id } = await h.createUser();
    const { access } = await tokensFor(id);

    const res = await get('/api/v1/auth/me').set(bearer(access));

    expect(res.status).toBe(200);
    expect(res.body.data._id).toBe(id);
    expect(res.body.data.tokenVersion).toBeUndefined();
    expect(res.body.data.password).toBeUndefined();
  });

  test('AC-05: rejects a refresh token used as Bearer (TOKEN_INVALID)', async () => {
    const { id } = await h.createUser();
    const { refresh } = await tokensFor(id);

    const res = await get('/api/v1/auth/me').set(bearer(refresh));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  test('rejects a legacy token without type/tv claims (issued before deploy)', async () => {
    const { id, email } = await h.createUser();
    const legacy = jwt.sign({ userId: id, email, roleName: 'ADMIN' }, process.env.JWT_SECRET, {
      expiresIn: '15m', issuer: 'TrustCar', audience: 'TrustCar-Client',
    });

    const res = await get('/api/v1/auth/me').set(bearer(legacy));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  test('rejects a token signed for another audience', async () => {
    const { id } = await h.createUser();
    const foreign = jwt.sign({ userId: id, type: 'access', tv: 0 }, process.env.JWT_SECRET, {
      expiresIn: '15m', issuer: 'TrustCar', audience: 'Other-Client',
    });

    const res = await get('/api/v1/auth/me').set(bearer(foreign));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  test('rejects a token whose tv no longer matches tokenVersion (revoked)', async () => {
    const { id } = await h.createUser();
    const { access } = await tokensFor(id);
    h.stored(id).tokenVersion = 1; // simulate logout / password change

    const res = await get('/api/v1/auth/me').set(bearer(access));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  test('missing token → TOKEN_MISSING', async () => {
    const res = await get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_MISSING');
  });

  test('expired access token → TOKEN_EXPIRED', async () => {
    const { id } = await h.createUser();
    const expired = jwt.sign({ userId: id, type: 'access', tv: 0 }, process.env.JWT_SECRET, {
      expiresIn: -10, issuer: 'TrustCar', audience: 'TrustCar-Client',
    });

    const res = await get('/api/v1/auth/me').set(bearer(expired));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  test('deactivated account with a current token → ACCOUNT_INACTIVE (GBR-21)', async () => {
    const { id } = await h.createUser();
    const { access } = await tokensFor(id);
    h.stored(id).isActive = false;

    const res = await get('/api/v1/auth/me').set(bearer(access));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ACCOUNT_INACTIVE');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// optionalAuth — REQ-012 / AC-18
// ════════════════════════════════════════════════════════════════════════════
describe('optionalAuth', () => {
  const run = (token) => new Promise((resolve, reject) => {
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
    optionalAuth(req, {}, (err) => (err ? reject(err) : resolve(req)));
  });

  test('attaches the user for a current access token without revocation data', async () => {
    const { id } = await h.createUser();
    const { access } = await tokensFor(id);

    const req = await run(access);

    expect(req.userId).toBe(id);
    expect(req.user.tokenVersion).toBeUndefined();
  });

  test('AC-18: revoked token → continues anonymously without error', async () => {
    const { id } = await h.createUser();
    const { access } = await tokensFor(id);
    h.stored(id).tokenVersion = 1;

    const req = await run(access);

    expect(req.user).toBeUndefined();
  });

  test('refresh token → continues anonymously', async () => {
    const { id } = await h.createUser();
    const { refresh } = await tokensFor(id);

    const req = await run(refresh);

    expect(req.user).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LOGOUT — REQ-013, REQ-014, REQ-015
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/auth/logout', () => {
  const post = (url) => request(h.app).post(url).set('X-Forwarded-For', h.nextIp());

  /** Logs the same account in on a "device" and returns its tokens. */
  const loginDevice = async ({ email, password }) => {
    const res = await post('/api/v1/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    return res.body.data;
  };

  test('AC-07: logout on device A revokes access and refresh tokens on A and B', async () => {
    const user = await h.createUser();
    const a = await loginDevice(user);
    const b = await loginDevice(user);

    const out = await post('/api/v1/auth/logout').set(bearer(a.accessToken));
    expect(out.status).toBe(200);
    expect(out.body.message).toBe('You have been logged out successfully.');

    for (const device of [a, b]) {
      const me = await get('/api/v1/auth/me').set(bearer(device.accessToken));
      expect(me.status).toBe(401);
      expect(me.body.code).toBe('TOKEN_INVALID');

      const refreshed = await post('/api/v1/auth/refresh').send({ refreshToken: device.refreshToken });
      expect(refreshed.status).toBe(401);
      expect(refreshed.body.code).toBe('REFRESH_TOKEN_INVALID');
    }
  });

  test('AC-08: logging in again after logout yields working tokens', async () => {
    const user = await h.createUser();
    const first = await loginDevice(user);
    await post('/api/v1/auth/logout').set(bearer(first.accessToken));

    const second = await loginDevice(user);
    const me = await get('/api/v1/auth/me').set(bearer(second.accessToken));

    expect(me.status).toBe(200);
  });

  test('AC-09: logout with an already revoked token → TOKEN_INVALID, no extra revocation', async () => {
    const user = await h.createUser();
    const tokens = await loginDevice(user);
    await post('/api/v1/auth/logout').set(bearer(tokens.accessToken));
    const versionAfterFirst = h.stored(user.id).tokenVersion;

    const again = await post('/api/v1/auth/logout').set(bearer(tokens.accessToken));

    expect(again.status).toBe(401);
    expect(again.body.code).toBe('TOKEN_INVALID');
    expect(h.stored(user.id).tokenVersion).toBe(versionAfterFirst);
  });

  test('REQ-014: logout without a token → TOKEN_MISSING', async () => {
    const res = await post('/api/v1/auth/logout');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_MISSING');
  });

  test('AC-19 (logout): exactly one USER_LOGOUT entry for the account', async () => {
    const user = await h.createUser();
    const tokens = await loginDevice(user);
    h.logs.length = 0;

    await post('/api/v1/auth/logout').set(bearer(tokens.accessToken));

    expect(h.logs).toHaveLength(1);
    expect(h.logs[0].eventType).toBe('USER_LOGOUT');
    expect(String(h.logs[0].targetId)).toBe(user.id);
  });
});
