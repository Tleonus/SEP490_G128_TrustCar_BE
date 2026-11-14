/**
 * @file google-sign-in.test.js
 * @description POST /api/v1/auth/google – Google sign-in / sign-up through
 * Firebase. The Firebase adapter is stubbed by the harness (`h.google`), so
 * no call leaves the process.
 */

import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();

const post = (url) => request(h.app).post(url).set('X-Forwarded-For', h.nextIp());
const get  = (url, token) => request(h.app).get(url).set('X-Forwarded-For', h.nextIp())
  .set('Authorization', `Bearer ${token}`);
const google = () => post('/api/v1/auth/google').send({ idToken: 'stubbed-firebase-id-token' });

const identity = (overrides = {}) => ({
  uid: 'google-uid-1', email: 'khach@gmail.com', emailVerified: true, name: 'Nguyen Van Khach', ...overrides,
});
const storedByEmail = (email) => [...h.users.values()].find((u) => u.email === email);

beforeEach(() => h.reset());

describe('POST /api/v1/auth/google', () => {
  test('AC-07: first sign-in creates an incomplete CUSTOMER account (no name from Google → empty)', async () => {
    h.google.next(identity({ name: null }));

    const res = await google();

    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({
      email: 'khach@gmail.com', roleName: 'CUSTOMER', profileCompleted: false,
      missingFields: ['fullName', 'phone', 'password'],
    });
    expect(res.body.data.user.firebaseUid).toBeUndefined();
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    const stored = storedByEmail('khach@gmail.com');
    expect(stored).toMatchObject({ firebaseUid: 'google-uid-1', roleName: 'CUSTOMER' });
    expect(stored.password).toBeUndefined();
    expect(stored.customer).toBeUndefined();
    expect(h.customers.size).toBe(0);
  });

  test('the Google name is kept when provided', async () => {
    h.google.next(identity());
    const res = await google();
    expect(res.body.data.user).toMatchObject({ fullName: 'Nguyen Van Khach', missingFields: ['phone', 'password'] });
  });

  test('AC-11: signing in again with the same Google identity reuses the account (200)', async () => {
    h.google.next(identity());
    const first = await google();
    const second = await google();

    expect(second.status).toBe(200);
    expect(second.body.data.user._id).toBe(first.body.data.user._id);
    expect(h.users.size).toBe(1);
  });

  test('AC-12: links Google to an existing email/password customer; password login still works', async () => {
    const { id, email, password } = await h.createUser({ roleName: 'CUSTOMER', email: 'khach@gmail.com', phone: '0901234567' });
    h.google.next(identity());

    const res = await google();

    expect(res.status).toBe(200);
    expect(res.body.data.user._id).toBe(id);
    expect(res.body.data.user.profileCompleted).toBe(true);
    expect(h.stored(id).firebaseUid).toBe('google-uid-1');
    expect((await post('/api/v1/auth/login').send({ email, password })).status).toBe(200);
  });

  test('AC-13: Google with a staff email → 403 GOOGLE_LOGIN_NOT_ALLOWED, nothing linked', async () => {
    const { id } = await h.createUser({ roleName: 'ADMIN', email: 'khach@gmail.com' });
    h.google.next(identity());

    const res = await google();

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('GOOGLE_LOGIN_NOT_ALLOWED');
    expect(res.body.data).toBeUndefined();
    expect(h.stored(id).firebaseUid).toBeUndefined();
  });

  test('AC-14: invalid token or unverified email → 401 GOOGLE_TOKEN_INVALID', async () => {
    h.google.fail('INVALID');
    const res = await google();
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('GOOGLE_TOKEN_INVALID');
    expect(h.users.size).toBe(0);
  });

  test('AC-15: email already linked to a different Google identity → 409 GOOGLE_ACCOUNT_CONFLICT', async () => {
    await h.createUser({ roleName: 'CUSTOMER', email: 'khach@gmail.com', firebaseUid: 'google-uid-OLD', password: null });
    h.google.next(identity({ uid: 'google-uid-NEW' }));

    const res = await google();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GOOGLE_ACCOUNT_CONFLICT');
  });

  test('AC-16: deactivated account → 401 ACCOUNT_INACTIVE', async () => {
    const { id } = await h.createUser({ roleName: 'CUSTOMER', firebaseUid: 'google-uid-1', password: null });
    h.stored(id).isActive = false;
    h.google.next(identity({ email: h.stored(id).email }));

    const res = await google();

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ACCOUNT_INACTIVE');
  });

  test('AC-16: Firebase unavailable → 503 GOOGLE_AUTH_UNAVAILABLE, token not logged', async () => {
    h.google.fail('UNAVAILABLE');
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    let res;
    try { res = await google(); } finally { console.error = original; }

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('GOOGLE_AUTH_UNAVAILABLE');
    expect(errors.join(' ')).not.toContain('stubbed-firebase-id-token');
  });

  test('missing idToken → 422', async () => {
    const res = await post('/api/v1/auth/google').send({});
    expect(res.status).toBe(422);
  });

  test('the issued session works on allowed routes and is gated elsewhere', async () => {
    h.google.next(identity());
    const { body: { data } } = await google();

    expect((await get('/api/v1/auth/me', data.accessToken)).status).toBe(200);
    const blocked = await request(h.app).patch('/api/v1/auth/change-password').set('X-Forwarded-For', h.nextIp())
      .set('Authorization', `Bearer ${data.accessToken}`)
      .send({ currentPassword: 'x', newPassword: 'NewCar2027', confirmPassword: 'NewCar2027' });
    expect(blocked.body.code).toBe('PROFILE_INCOMPLETE');
  });

  test('AC-20 (google): registration, linking and sign-in are each logged once', async () => {
    h.google.next(identity());
    await google();                                   // CUSTOMER_REGISTERED
    await google();                                   // USER_LOGIN
    await h.createUser({ roleName: 'CUSTOMER', email: 'b@gmail.com', phone: '0912345678' });
    h.google.next(identity({ uid: 'google-uid-2', email: 'b@gmail.com' }));
    await google();                                   // GOOGLE_LINKED + USER_LOGIN

    expect(h.logs.map((l) => l.eventType))
      .toEqual(['CUSTOMER_REGISTERED', 'USER_LOGIN', 'GOOGLE_LINKED', 'USER_LOGIN']);
    expect(JSON.stringify(h.logs)).not.toContain('stubbed-firebase-id-token');
  });
});
