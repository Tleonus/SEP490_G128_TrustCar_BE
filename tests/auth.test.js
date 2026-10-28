/**
 * @file auth.test.js
 * @description Integration tests for /api/v1/auth running the REAL app code
 * (routes, Joi validation, controllers, services, middlewares) on top of the
 * in-memory persistence harness in tests/helpers/fakeAuthModels.js.
 *
 * No MongoDB connection is opened.
 */

import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();

/** POST/GET helpers that give every request its own client IP (see harness). */
const post = (url) => request(h.app).post(url).set('X-Forwarded-For', h.nextIp());

beforeEach(() => h.reset());

// ════════════════════════════════════════════════════════════════════════════
// HARNESS SELF-CHECKS — the fake persistence must behave like MongoDB for the
// operations the auth code relies on, otherwise green tests mean nothing.
// ════════════════════════════════════════════════════════════════════════════
describe('Test harness – in-memory persistence', () => {
  test('select:false fields are hidden unless explicitly selected', async () => {
    const { id } = await h.createUser();

    const plain = await h.User.findById(id);
    const withHidden = await h.User.findById(id).select('+password +tokenVersion');

    expect(plain.password).toBeUndefined();
    expect(plain.tokenVersion).toBeUndefined();
    expect(withHidden.password).toMatch(/^\$2[aby]\$/); // stored as bcrypt hash
    expect(withHidden.tokenVersion).toBe(0);
  });

  test('updateOne $inc increments a counter', async () => {
    const { id } = await h.createUser();
    await h.User.updateOne({ _id: id }, { $inc: { tokenVersion: 1 } });
    await h.User.updateOne({ _id: id }, { $inc: { tokenVersion: 1 } });
    expect(h.stored(id).tokenVersion).toBe(2);
  });

  test('findOneAndUpdate matches dot paths and $gt, applies $set/$unset/$inc once', async () => {
    const { id } = await h.createUser();
    h.stored(id).passwordResetToken = { token: 'abc', expiresAt: new Date(Date.now() + 60_000) };

    const filter = {
      'passwordResetToken.token':     'abc',
      'passwordResetToken.expiresAt': { $gt: new Date() },
      isActive: true,
    };
    const update = { $set: { fullName: 'Changed' }, $unset: { passwordResetToken: 1 }, $inc: { tokenVersion: 1 } };

    const first  = await h.User.findOneAndUpdate(filter, update, { new: true });
    const second = await h.User.findOneAndUpdate(filter, update, { new: true });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(h.stored(id).passwordResetToken).toBeUndefined();
    expect(h.stored(id).tokenVersion).toBe(1);
    expect(h.stored(id).fullName).toBe('Changed');
  });

  test('findOneAndUpdate does not match an expired date', async () => {
    const { id } = await h.createUser();
    h.stored(id).passwordResetToken = { token: 'old', expiresAt: new Date(Date.now() - 1) };
    const res = await h.User.findOneAndUpdate(
      { 'passwordResetToken.token': 'old', 'passwordResetToken.expiresAt': { $gt: new Date() } },
      { $unset: { passwordResetToken: 1 } },
      { new: true }
    );
    expect(res).toBeNull();
  });

  test('save() hashes a modified password and persists only modified paths', async () => {
    const { id } = await h.createUser({ password: 'TrustCar2026' });
    const doc = await h.User.findById(id).select('+password');
    doc.password = 'NewPass2026';
    await doc.save();

    const reloaded = await h.User.findById(id).select('+password');
    expect(await reloaded.comparePassword('NewPass2026')).toBe(true);
    expect(h.stored(id).tokenVersion).toBe(0); // untouched hidden field kept
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SMOKE — real login endpoint end-to-end through the harness
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/auth/login (smoke)', () => {
  test('returns tokens and a user without secrets for valid credentials', async () => {
    const { email, password } = await h.createUser();

    const res = await post('/api/v1/auth/login').send({ email, password });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken).toEqual(expect.any(String));
    expect(res.body.data.user.email).toBe(email);
    expect(res.body.data.user.password).toBeUndefined();
    expect(res.body.data.user.tokenVersion).toBeUndefined();
  });

  test('rejects a body without password via Joi validation (422)', async () => {
    const res = await post('/api/v1/auth/login').send({ email: 'a@trustcar.vn' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LOGIN — REQ-001…005, REQ-029, REQ-030
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/auth/login', () => {
  const login = (body) => post('/api/v1/auth/login').send(body);

  test('AC-01: issued access token works on a protected route', async () => {
    const { email, password } = await h.createUser();
    const res = await login({ email, password });

    const me = await request(h.app).get('/api/v1/auth/me')
      .set('X-Forwarded-For', h.nextIp())
      .set('Authorization', `Bearer ${res.body.data.accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(email);
  });

  test('AC-02: 10 wrong passwords never lock the account; the correct one still works', async () => {
    const { email, password } = await h.createUser();

    for (let i = 0; i < 10; i += 1) {
      const bad = await login({ email, password: 'WrongPass1' });
      expect(bad.status).toBe(401);
      expect(bad.body.code).toBe('INVALID_CREDENTIALS');
    }

    const ok = await login({ email, password });
    expect(ok.status).toBe(200);
  });

  test('AC-03: unknown email returns the same error as a wrong password', async () => {
    const { email } = await h.createUser();

    const unknown = await login({ email: 'nobody@trustcar.vn', password: 'TrustCar2026' });
    const wrong   = await login({ email, password: 'WrongPass1' });

    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  test('AC-04: deactivated account – wrong password → INVALID_CREDENTIALS, right password → ACCOUNT_INACTIVE', async () => {
    const { email, password } = await h.createUser({ isActive: false });

    const wrong = await login({ email, password: 'WrongPass1' });
    const right = await login({ email, password });

    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    expect(right.status).toBe(401);
    expect(right.body.code).toBe('ACCOUNT_INACTIVE');
    expect(right.body.data).toBeUndefined();
  });

  test('email is matched case-insensitively', async () => {
    const { password } = await h.createUser({ email: 'mixed@trustcar.vn' });
    const res = await login({ email: 'MIXED@TrustCar.vn', password });
    expect(res.status).toBe(200);
  });

  test('AC-19 (login): success and wrong password are logged; unknown email is not', async () => {
    const { id, email, password } = await h.createUser();

    await login({ email, password });
    await login({ email, password: 'WrongPass1' });
    await login({ email: 'nobody@trustcar.vn', password: 'WrongPass1' });

    expect(h.logs.map((l) => l.eventType)).toEqual(['USER_LOGIN', 'LOGIN_FAILED']);
    expect(h.logs.every((l) => String(l.targetId) === id)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REFRESH — REQ-007, REQ-008, REQ-009
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/auth/refresh', () => {
  const loginTokens = async (overrides) => {
    const u = await h.createUser(overrides);
    const res = await post('/api/v1/auth/login').send({ email: u.email, password: u.password });
    return { ...u, ...res.body.data };
  };
  const refresh = (refreshToken) => post('/api/v1/auth/refresh').send({ refreshToken });

  test('REQ-008: a valid refresh token yields a working access token', async () => {
    const { refreshToken } = await loginTokens();

    const res = await refresh(refreshToken);
    const me = await request(h.app).get('/api/v1/auth/me')
      .set('X-Forwarded-For', h.nextIp())
      .set('Authorization', `Bearer ${res.body.data.accessToken}`);

    expect(res.status).toBe(200);
    expect(me.status).toBe(200);
  });

  test('AC-06: an access token is rejected by the refresh endpoint', async () => {
    const { accessToken } = await loginTokens();
    const res = await refresh(accessToken);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REFRESH_TOKEN_INVALID');
  });

  test('REQ-009: revoked refresh token (tokenVersion bumped) is rejected', async () => {
    const { id, refreshToken } = await loginTokens();
    h.stored(id).tokenVersion += 1;

    const res = await refresh(refreshToken);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REFRESH_TOKEN_INVALID');
  });

  test('REQ-009: refresh for a deactivated account is rejected', async () => {
    const { id, refreshToken } = await loginTokens();
    h.stored(id).isActive = false;

    const res = await refresh(refreshToken);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REFRESH_TOKEN_INVALID');
  });

  test('REQ-009: garbage refresh token is rejected', async () => {
    const res = await refresh('not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REFRESH_TOKEN_INVALID');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SAME BEHAVIOUR FOR EVERY ACCOUNT TYPE — DoD #6, REQ-028
// ════════════════════════════════════════════════════════════════════════════
describe.each(['ADMIN', 'SALES_STAFF'])('full session lifecycle for role %s', (roleName) => {
  test('login → /me → logout → token rejected', async () => {
    const { email, password } = await h.createUser({ roleName });

    const { body: { data } } = await post('/api/v1/auth/login').send({ email, password });
    const auth = { Authorization: `Bearer ${data.accessToken}` };
    const get  = () => request(h.app).get('/api/v1/auth/me').set('X-Forwarded-For', h.nextIp()).set(auth);

    const me = await get();
    expect(me.status).toBe(200);
    expect(me.body.data.roleName).toBe(roleName);

    expect((await post('/api/v1/auth/logout').set(auth)).status).toBe(200);
    expect((await get()).status).toBe(401);
  });
});

describe('GET /api/v1/auth/me – REQ-028', () => {
  test('never returns password, reset link or revocation data', async () => {
    const { id, email, password } = await h.createUser();
    await post('/api/v1/auth/forgot-password').send({ email });
    expect(h.stored(id).passwordResetToken).toBeDefined();

    const { body: { data } } = await post('/api/v1/auth/login').send({ email, password });
    const me = await request(h.app).get('/api/v1/auth/me')
      .set('X-Forwarded-For', h.nextIp())
      .set('Authorization', `Bearer ${data.accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.data.password).toBeUndefined();
    expect(me.body.data.passwordResetToken).toBeUndefined();
    expect(me.body.data.tokenVersion).toBeUndefined();
  });
});
