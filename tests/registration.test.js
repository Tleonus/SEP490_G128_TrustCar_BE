/**
 * @file registration.test.js
 * @description POST /api/v1/auth/register – customer self-registration with
 * email + password and linking to the showroom Customer profile.
 *
 * Runs the real app on the in-memory persistence harness (no MongoDB).
 */

import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();

const post = (url) => request(h.app).post(url).set('X-Forwarded-For', h.nextIp());
const get  = (url, token) => request(h.app).get(url).set('X-Forwarded-For', h.nextIp())
  .set('Authorization', `Bearer ${token}`);

const form = (overrides = {}) => ({
  email: 'khach@gmail.com', password: 'TrustCar2026', confirmPassword: 'TrustCar2026',
  fullName: 'Nguyen Van Khach', phone: '0901234567', ...overrides,
});
const register = (overrides) => post('/api/v1/auth/register').send(form(overrides));
const storedUserByEmail = (email) => [...h.users.values()].find((u) => u.email === email);

beforeEach(() => h.reset());

describe('POST /api/v1/auth/register', () => {
  test('AC-01: creates a complete CUSTOMER account, a WEBSITE Customer, and logs in', async () => {
    const res = await register();

    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({
      email: 'khach@gmail.com', roleName: 'CUSTOMER', profileCompleted: true, missingFields: [],
    });
    expect(res.body.data.user.password).toBeUndefined();

    const stored = storedUserByEmail('khach@gmail.com');
    const [customer] = [...h.customers.values()];
    expect(h.customers.size).toBe(1);
    expect(customer).toMatchObject({ phone: '0901234567', email: 'khach@gmail.com', source: 'WEBSITE' });
    expect(String(stored.customer)).toBe(String(customer._id));
    expect(String(stored.role)).toBe(String(h.roleIds.CUSTOMER));

    expect((await get('/api/v1/auth/me', res.body.data.accessToken)).status).toBe(200);
  });

  test('phone is normalised (+84…) before storing and matching', async () => {
    const res = await register({ phone: '+84901234567' });
    expect(res.status).toBe(201);
    expect(storedUserByEmail('khach@gmail.com').phone).toBe('0901234567');
  });

  test('AC-02: links to the single matching active Customer without modifying it (email stays empty)', async () => {
    const existing = await h.createCustomer({ fullName: 'Ten Showroom', phone: '0901234567', email: null });

    await register({ fullName: 'Ten Dang Ky' });

    expect(h.customers.size).toBe(1);
    expect(String(storedUserByEmail('khach@gmail.com').customer)).toBe(existing);
    expect(h.customers.get(existing)).toMatchObject({ fullName: 'Ten Showroom', email: null });
  });

  test('AC-02: an existing Customer email is not overwritten', async () => {
    const existing = await h.createCustomer({ phone: '0901234567', email: 'cu@gmail.com' });
    await register();
    expect(h.customers.get(existing).email).toBe('cu@gmail.com');
  });

  test('AC-03: two Customers with the same phone → a new Customer is created', async () => {
    await h.createCustomer({ phone: '0901234567' });
    await h.createCustomer({ phone: '0901234567' });

    await register();

    expect(h.customers.size).toBe(3);
    const linked = h.customers.get(String(storedUserByEmail('khach@gmail.com').customer));
    expect(linked.source).toBe('WEBSITE');
  });

  test('an inactive Customer is never reused', async () => {
    const inactive = await h.createCustomer({ phone: '0901234567', isActive: false });
    await register();
    expect(String(storedUserByEmail('khach@gmail.com').customer)).not.toBe(inactive);
  });

  test('AC-04: duplicate email → 409 EMAIL_ALREADY_EXISTS, nothing created', async () => {
    await h.createUser({ email: 'khach@gmail.com', roleName: 'SALES_STAFF' });
    const usersBefore = h.users.size;

    const res = await register();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_ALREADY_EXISTS');
    expect(h.users.size).toBe(usersBefore);
    expect(h.customers.size).toBe(0);
  });

  test('AC-04: phone already used by another customer account → 409 PHONE_ALREADY_EXISTS', async () => {
    await register();
    const res = await register({ email: 'other@gmail.com' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PHONE_ALREADY_EXISTS');
    expect(h.customers.size).toBe(1);
  });

  test('a staff member sharing the phone does not block registration', async () => {
    await h.createUser({ roleName: 'SALES_STAFF', phone: '0901234567' });
    expect((await register()).status).toBe(201);
  });

  test.each([
    ['missing full name', { fullName: undefined }],
    ['invalid phone', { phone: '12345' }],
    ['weak password', { password: 'abc123xy', confirmPassword: 'abc123xy' }],
    ['confirm mismatch', { confirmPassword: 'Different2026' }],
    ['invalid email', { email: 'not-an-email' }],
  ])('AC-05: %s → 422, nothing created', async (_label, overrides) => {
    const res = await register(overrides);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(h.users.size).toBe(0);
    expect(h.customers.size).toBe(0);
  });

  test('AC-06: concurrent registrations with the same email → one 201, one 409, no orphan Customer', async () => {
    const [a, b] = await Promise.all([register(), register({ phone: '0912345678' })]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(h.users.size).toBe(1);
    expect(h.customers.size).toBe(1);
  });

  test('AC-20 (register): one CUSTOMER_REGISTERED entry, no secrets in the log', async () => {
    await register();
    expect(h.logs.map((l) => l.eventType)).toEqual(['CUSTOMER_REGISTERED']);
    expect(JSON.stringify(h.logs)).not.toContain('TrustCar2026');
  });
});

describe('AC-19 / REQ-025: KAN-9 session rules apply to customers', () => {
  test('customer logout revokes access and refresh tokens', async () => {
    const { body: { data } } = await register();

    const out = await request(h.app).post('/api/v1/auth/logout').set('X-Forwarded-For', h.nextIp())
      .set('Authorization', `Bearer ${data.accessToken}`);
    expect(out.status).toBe(200);
    expect((await get('/api/v1/auth/me', data.accessToken)).status).toBe(401);
    expect((await post('/api/v1/auth/refresh').send({ refreshToken: data.refreshToken })).status).toBe(401);
  });

  test('a complete customer can change their password like any user', async () => {
    const { body: { data } } = await register();
    const res = await request(h.app).patch('/api/v1/auth/change-password').set('X-Forwarded-For', h.nextIp())
      .set('Authorization', `Bearer ${data.accessToken}`)
      .send({ currentPassword: 'TrustCar2026', newPassword: 'NewCar2027', confirmPassword: 'NewCar2027' });
    expect(res.status).toBe(200);
  });
});
