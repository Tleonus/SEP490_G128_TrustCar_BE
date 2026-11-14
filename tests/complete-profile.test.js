/**
 * @file complete-profile.test.js
 * @description Incomplete customer profiles: what the API allows before the
 * profile is completed, and the complete-profile flow itself.
 *
 * Runs the real app on the in-memory persistence harness (no MongoDB).
 */

import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
const { signAccessToken, signRefreshToken } = await import('../src/utils/authTokens.js');

const call = (method, url, token) => {
  const req = request(h.app)[method](url).set('X-Forwarded-For', h.nextIp());
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

/** A Google-created customer: no phone, no password, optionally no name. */
const googleCustomer = async (overrides = {}) => {
  const { id, email } = await h.createUser({
    roleName: 'CUSTOMER', firebaseUid: `g-${Date.now()}-${Math.random()}`, password: null,
    fullName: undefined, ...overrides,
  });
  const user = await h.User.findById(id).select('+tokenVersion');
  return { id, email, access: signAccessToken(user), refresh: signRefreshToken(user) };
};

beforeEach(() => h.reset());

// ════════════════════════════════════════════════════════════════════════════
// GATE — REQ-015, REQ-016, REQ-022, REQ-024
// ════════════════════════════════════════════════════════════════════════════
describe('incomplete customer profile gate', () => {
  test('/me works and reports what is missing', async () => {
    const { access } = await googleCustomer();

    const res = await call('get', '/api/v1/auth/me', access);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ profileCompleted: false, missingFields: ['fullName', 'phone', 'password'] });
    expect(res.body.data.password).toBeUndefined();
    expect(res.body.data.firebaseUid).toBeUndefined();
  });

  test('AC-08: other protected APIs answer 403 PROFILE_INCOMPLETE (e.g. change password)', async () => {
    const { access } = await googleCustomer({ fullName: 'An' });

    const res = await call('patch', '/api/v1/auth/change-password', access)
      .send({ currentPassword: 'x', newPassword: 'NewCar2027', confirmPassword: 'NewCar2027' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PROFILE_INCOMPLETE');
  });

  test('logout still works and revokes the session', async () => {
    const { access } = await googleCustomer();

    expect((await call('post', '/api/v1/auth/logout', access)).status).toBe(200);
    expect((await call('get', '/api/v1/auth/me', access)).status).toBe(401);
  });

  test('refresh still works for an incomplete profile', async () => {
    const { refresh } = await googleCustomer();
    const res = await call('post', '/api/v1/auth/refresh').send({ refreshToken: refresh });
    expect(res.status).toBe(200);
  });

  test('a deactivated incomplete account gets ACCOUNT_INACTIVE, not PROFILE_INCOMPLETE', async () => {
    const { id, access } = await googleCustomer();
    h.stored(id).isActive = false;
    const res = await call('get', '/api/v1/auth/me', access);
    expect(res.body.code).toBe('ACCOUNT_INACTIVE');
  });

  test('AC-17 / REQ-022: password login into an account without password → INVALID_CREDENTIALS', async () => {
    const { email } = await googleCustomer();

    const res = await call('post', '/api/v1/auth/login').send({ email, password: 'Whatever2026' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  test('staff and complete customers are not affected; login reports profile status', async () => {
    const staff = await h.createUser({ roleName: 'SALES_STAFF' });
    const customer = await h.createUser({ roleName: 'CUSTOMER', phone: '0901234567' });

    for (const { email, password } of [staff, customer]) {
      const login = await call('post', '/api/v1/auth/login').send({ email, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ profileCompleted: true, missingFields: [] });
      const me = await call('get', '/api/v1/auth/me', login.body.data.accessToken);
      expect(me.body.data.profileCompleted).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// COMPLETE PROFILE — REQ-017…020, REQ-023, REQ-028
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/auth/complete-profile', () => {
  const complete = (token, body) => call('patch', '/api/v1/auth/complete-profile', token).send(body);
  const allFields = {
    fullName: 'Nguyen Van Khach', phone: '0901234567', password: 'TrustCar2026', confirmPassword: 'TrustCar2026',
  };

  test('AC-09: filling every missing field completes the profile, links a Customer, keeps the session', async () => {
    const { id, email, access } = await googleCustomer();

    const res = await complete(access, allFields);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ profileCompleted: true, missingFields: [], phone: '0901234567' });
    expect(res.body.data.password).toBeUndefined();
    const customer = h.customers.get(String(h.stored(id).customer));
    expect(customer).toMatchObject({ phone: '0901234567', email, source: 'WEBSITE', fullName: 'Nguyen Van Khach' });
    expect((await call('get', '/api/v1/auth/me', access)).body.data.profileCompleted).toBe(true);
    expect((await call('post', '/api/v1/auth/login').send({ email, password: 'TrustCar2026' })).status).toBe(200);
  });

  test('links to an existing showroom Customer with the same phone', async () => {
    const existing = await h.createCustomer({ phone: '0901234567', email: null });
    const { id, access } = await googleCustomer();

    await complete(access, allFields);

    expect(String(h.stored(id).customer)).toBe(existing);
    expect(h.customers.size).toBe(1);
    expect(h.customers.get(existing).email).toBeNull(); // linked Customer is never modified
  });

  test('AC-10: a missing field in the request → 422, profile stays incomplete', async () => {
    const { id, access } = await googleCustomer();
    const { password, confirmPassword, ...withoutPassword } = allFields;

    const res = await complete(access, withoutPassword);

    expect(res.status).toBe(422);
    expect(h.stored(id).phone).toBeUndefined();
  });

  test('sending a field that is already set → 422', async () => {
    const { access } = await googleCustomer({ fullName: 'An' });
    const res = await complete(access, allFields); // fullName already present
    expect(res.status).toBe(422);
  });

  test('an already complete profile → 422', async () => {
    const { email, password } = await h.createUser({ roleName: 'CUSTOMER', phone: '0909999999' });
    const login = await call('post', '/api/v1/auth/login').send({ email, password });
    const res = await complete(login.body.data.accessToken, { fullName: 'Ten Moi' });
    expect(res.status).toBe(422);
  });

  test('AC-10 / REQ-019: phone already used by another customer → 409, nothing saved', async () => {
    await h.createUser({ roleName: 'CUSTOMER', phone: '0901234567' });
    const { id, access } = await googleCustomer();

    const res = await complete(access, allFields);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PHONE_ALREADY_EXISTS');
    expect(h.stored(id).password).toBeUndefined();
    expect(h.customers.size).toBe(0);
  });

  test('weak password or confirm mismatch → 422', async () => {
    const { access } = await googleCustomer();
    expect((await complete(access, { ...allFields, password: 'abc123xy', confirmPassword: 'abc123xy' })).status).toBe(422);
    expect((await complete(access, { ...allFields, confirmPassword: 'Other2026x' })).status).toBe(422);
  });

  test('AC-17 / REQ-023: a password set via forgot/reset no longer counts as missing', async () => {
    const { id, email, access } = await googleCustomer({ fullName: 'An' });
    await call('post', '/api/v1/auth/forgot-password').send({ email });
    const link = h.stored(id).passwordResetToken.token;

    const reset = await call('post', '/api/v1/auth/reset-password')
      .send({ token: link, newPassword: 'TrustCar2026', confirmPassword: 'TrustCar2026' });
    expect(reset.status).toBe(200);

    const login = await call('post', '/api/v1/auth/login').send({ email, password: 'TrustCar2026' });
    expect(login.body.data.user.missingFields).toEqual(['phone']);
    expect((await call('get', '/api/v1/auth/me', access)).status).toBe(401); // reset revoked old sessions (KAN-9)
  });

  test('AC-20 (complete): one PROFILE_COMPLETED entry, no password in the log', async () => {
    const { access } = await googleCustomer();
    h.logs.length = 0;
    await complete(access, allFields);
    expect(h.logs.map((l) => l.eventType)).toEqual(['PROFILE_COMPLETED']);
    expect(JSON.stringify(h.logs)).not.toContain('TrustCar2026');
  });
});
