/**
 * @file auth-password.test.js
 * @description Password policy and password-change / reset flow tests.
 *
 * Part 1 (this section): pure validator tests for the shared password policy
 * (GBR-22) used by auth and user-management DTO schemas.
 * Later sections exercise the real change-password and reset-password
 * endpoints through the test harness in tests/helpers/fakeAuthModels.js.
 */

import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
const { joiPassword, isStrongPassword, PASSWORD_REGEX } = await import('../src/utils/validators.js');

const post  = (url) => request(h.app).post(url).set('X-Forwarded-For', h.nextIp());
const patch = (url) => request(h.app).patch(url).set('X-Forwarded-For', h.nextIp());
const get   = (url) => request(h.app).get(url).set('X-Forwarded-For', h.nextIp());
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

const loginDevice = async ({ email, password }) => {
  const res = await post('/api/v1/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.data;
};

beforeEach(() => h.reset());

const VALID_PASSWORDS = [
  'TrustCar2026',    // no special character – allowed
  'TrustCar@2026',   // special character – still allowed
  'Abc123xy',        // exactly 8 chars
  'A1' + 'b'.repeat(126), // exactly 128 chars
];

const INVALID_PASSWORDS = [
  ['abc123xy',            'missing uppercase'],
  ['Abcdefgh',            'missing digit'],
  ['ABC123XY',            'missing lowercase'],
  ['Abc 123xy',           'contains a space'],
  ['Mậtkhẩu12',           'contains accented letters'],
  ['Abc123.xy',           'contains a disallowed character "."'],
  ['Abc12xy',             'only 7 characters'],
  ['A1' + 'b'.repeat(127), '129 characters'],
];

describe('Password policy (GBR-22) – shared validator', () => {
  test.each(VALID_PASSWORDS)('accepts "%s"', (password) => {
    expect(isStrongPassword(password)).toBe(true);
    expect(joiPassword().required().validate(password).error).toBeUndefined();
  });

  test.each(INVALID_PASSWORDS)('rejects "%s" (%s)', (password) => {
    expect(isStrongPassword(password)).toBe(false);
    expect(joiPassword().required().validate(password).error).toBeDefined();
  });

  test('regex does not require a special character', () => {
    expect(PASSWORD_REGEX.source).not.toContain('(?=.*[!@#$%^&*');
  });

  test('isStrongPassword rejects non-string input', () => {
    expect(isStrongPassword(undefined)).toBe(false);
    expect(isStrongPassword(12345678)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CHANGE PASSWORD — REQ-016…020, REQ-033/034
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/auth/change-password', () => {
  const change = (token, body) => patch('/api/v1/auth/change-password').set(bearer(token)).send(body);
  const body = (currentPassword, newPassword, confirmPassword = newPassword) =>
    ({ currentPassword, newPassword, confirmPassword });

  test('AC-10: success revokes every session, returns no token, only the new password works', async () => {
    const user = await h.createUser({ password: 'TrustCar2026' });
    const a = await loginDevice(user);
    const b = await loginDevice(user);

    const res = await change(a.accessToken, body('TrustCar2026', 'NewCar2027'));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeUndefined();
    for (const device of [a, b]) {
      expect((await get('/api/v1/auth/me').set(bearer(device.accessToken))).status).toBe(401);
      expect((await post('/api/v1/auth/refresh').send({ refreshToken: device.refreshToken })).status).toBe(401);
    }
    expect((await post('/api/v1/auth/login').send({ email: user.email, password: 'TrustCar2026' })).status).toBe(401);
    expect((await post('/api/v1/auth/login').send({ email: user.email, password: 'NewCar2027' })).status).toBe(200);
  });

  test('AC-11: wrong current password → 400 CURRENT_PASSWORD_WRONG and the session survives', async () => {
    const user = await h.createUser();
    const s = await loginDevice(user);

    const res = await change(s.accessToken, body('WrongPass1', 'NewCar2027'));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CURRENT_PASSWORD_WRONG');
    expect((await get('/api/v1/auth/me').set(bearer(s.accessToken))).status).toBe(200);
  });

  test('AC-12: new password equal to the current one → 422 PASSWORD_SAME', async () => {
    const user = await h.createUser({ password: 'TrustCar2026' });
    const s = await loginDevice(user);

    const res = await change(s.accessToken, body('TrustCar2026', 'TrustCar2026'));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PASSWORD_SAME');
  });

  test.each(INVALID_PASSWORDS)('AC-21: rejects new password "%s" (%s) with 422 and keeps the old one', async (bad) => {
    const user = await h.createUser({ password: 'TrustCar2026' });
    const s = await loginDevice(user);

    const res = await change(s.accessToken, body('TrustCar2026', bad));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect((await post('/api/v1/auth/login').send({ email: user.email, password: 'TrustCar2026' })).status).toBe(200);
  });

  test('REQ-019: confirmPassword mismatch → 422', async () => {
    const user = await h.createUser({ password: 'TrustCar2026' });
    const s = await loginDevice(user);
    const res = await change(s.accessToken, body('TrustCar2026', 'NewCar2027', 'NewCar2028'));
    expect(res.status).toBe(422);
  });

  test('REQ-020: only the account in the token is changed', async () => {
    const owner = await h.createUser({ password: 'TrustCar2026' });
    const other = await h.createUser({ password: 'Other2026x' });
    const s = await loginDevice(owner);

    await change(s.accessToken, { ...body('TrustCar2026', 'NewCar2027'), userId: other.id });

    expect((await post('/api/v1/auth/login').send({ email: other.email, password: 'Other2026x' })).status).toBe(200);
  });

  test('AC-19 (change): exactly one PASSWORD_CHANGED entry', async () => {
    const user = await h.createUser({ password: 'TrustCar2026' });
    const s = await loginDevice(user);
    h.logs.length = 0;

    await change(s.accessToken, body('TrustCar2026', 'NewCar2027'));

    expect(h.logs.map((l) => l.eventType)).toEqual(['PASSWORD_CHANGED']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FORGOT / RESET PASSWORD — REQ-021…027, REQ-033/034
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/auth/forgot-password + /reset-password', () => {
  const forgot = (email) => post('/api/v1/auth/forgot-password').send({ email });
  const reset  = (token, newPassword, confirmPassword = newPassword) =>
    post('/api/v1/auth/reset-password').send({ token, newPassword, confirmPassword });
  const linkOf = (id) => h.stored(id).passwordResetToken?.token;

  test('AC-13: identical 200 response for registered, unknown, deactivated and mail-failure cases', async () => {
    const active   = await h.createUser();
    const inactive = await h.createUser({ isActive: false });
    const failing  = await h.createUser();

    const registered = await forgot(active.email);
    const unknown    = await forgot('nobody@trustcar.vn');
    const disabled   = await forgot(inactive.email);
    h.mail.fail = true;
    const mailDown   = await forgot(failing.email);

    for (const res of [registered, unknown, disabled, mailDown]) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual(registered.body);
    }
    expect(h.mail.sent.map((m) => m.to)).toEqual([active.email]);
  });

  test('REQ-023 / NFR-05: a mail failure is logged server-side without the reset link', async () => {
    const user = await h.createUser();
    h.mail.fail = true;
    // Capture console.error by hand: importing `jest` here would rebind the
    // harness's module mocks to this file's path.
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      await forgot(user.email);
    } finally {
      console.error = original;
    }

    const token = linkOf(user.id);
    expect(errors.some((e) => e.includes('Password reset email failed'))).toBe(true);
    expect(errors.some((e) => e.includes(token))).toBe(false);
    expect(h.logs).toHaveLength(0); // nothing dispatched → no audit entry
  });

  test('audit L1: the user name is HTML-escaped in the reset email, the link is intact', async () => {
    const user = await h.createUser({ fullName: '<b>X</b> & "Y"' });

    await forgot(user.email);

    const { html } = h.mail.sent[0];
    expect(html).toContain('Xin chào &lt;b&gt;X&lt;/b&gt; &amp; &quot;Y&quot;,');
    expect(html).not.toContain('<b>X</b>');
    expect(html).toContain(`reset-password?token=${linkOf(user.id)}`);
  });

  test('AC-14: a newer link invalidates the previous one', async () => {
    const user = await h.createUser();
    await forgot(user.email);
    const first = linkOf(user.id);
    await forgot(user.email);
    const second = linkOf(user.id);

    expect(first).not.toBe(second);
    expect((await reset(first, 'NewCar2027')).body.code).toBe('RESET_TOKEN_INVALID');
    expect((await reset(second, 'NewCar2027')).status).toBe(200);
  });

  test('AC-15: success revokes every session, the link cannot be reused, only the new password works', async () => {
    const user = await h.createUser({ password: 'TrustCar2026' });
    const session = await loginDevice(user);
    await forgot(user.email);
    const link = linkOf(user.id);

    const ok    = await reset(link, 'NewCar2027');
    const reuse = await reset(link, 'Another2028');

    expect(ok.status).toBe(200);
    expect(reuse.status).toBe(400);
    expect(reuse.body.code).toBe('RESET_TOKEN_INVALID');
    expect((await get('/api/v1/auth/me').set(bearer(session.accessToken))).status).toBe(401);
    expect((await post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken })).status).toBe(401);
    expect((await post('/api/v1/auth/login').send({ email: user.email, password: 'TrustCar2026' })).status).toBe(401);
    expect((await post('/api/v1/auth/login').send({ email: user.email, password: 'NewCar2027' })).status).toBe(200);
    expect(h.stored(user.id).password).toMatch(/^\$2[aby]\$/); // hashed despite the atomic update
  });

  test('AC-16: a link older than one hour is rejected', async () => {
    const user = await h.createUser();
    await forgot(user.email);
    const link = linkOf(user.id);
    h.stored(user.id).passwordResetToken.expiresAt = new Date(Date.now() - 1000);

    const res = await reset(link, 'NewCar2027');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RESET_TOKEN_INVALID');
  });

  test('link expiry is one hour after the request (REQ-021)', async () => {
    const user = await h.createUser();
    const before = Date.now();
    await forgot(user.email);
    const expiresAt = h.stored(user.id).passwordResetToken.expiresAt.getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(59 * 60 * 1000);
    expect(expiresAt - before).toBeLessThanOrEqual(61 * 60 * 1000);
  });

  test('AC-17: two concurrent resets with the same link → exactly one succeeds', async () => {
    const user = await h.createUser();
    await forgot(user.email);
    const link = linkOf(user.id);

    const results = await Promise.all([reset(link, 'NewCar2027'), reset(link, 'Other2028x')]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(h.stored(user.id).tokenVersion).toBe(1);
  });

  test('audit M1: a bogus token is rejected without hashing the new password', async () => {
    await h.createUser();
    h.hashSpy.mockClear(); // createUser hashes the initial password

    const res = await reset('bogus-token-value', 'NewCar2027');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RESET_TOKEN_INVALID');
    expect(h.hashSpy).not.toHaveBeenCalled();
  });

  test('REQ-025: a deactivated account cannot use its link', async () => {
    const user = await h.createUser();
    await forgot(user.email);
    const link = linkOf(user.id);
    h.stored(user.id).isActive = false;

    expect((await reset(link, 'NewCar2027')).body.code).toBe('RESET_TOKEN_INVALID');
  });

  test.each(INVALID_PASSWORDS)('AC-21 / REQ-027: rejects "%s" (%s) with 422 and keeps the link usable', async (bad) => {
    const user = await h.createUser();
    await forgot(user.email);
    const link = linkOf(user.id);

    const res = await reset(link, bad);

    expect(res.status).toBe(422);
    expect(linkOf(user.id)).toBe(link);
    expect((await reset(link, 'NewCar2027')).status).toBe(200);
  });

  test('AC-19 (forgot/reset): one PASSWORD_RESET entry per dispatched email and per successful reset', async () => {
    const user = await h.createUser();
    await forgot(user.email);
    await reset(linkOf(user.id), 'NewCar2027');

    expect(h.logs.map((l) => l.eventType)).toEqual(['PASSWORD_RESET', 'PASSWORD_RESET']);
  });
});
