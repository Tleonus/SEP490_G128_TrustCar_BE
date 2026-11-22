/**
 * @file profile-access.test.js
 * @description Who may call the profile API: no token, a broken or revoked token, an inactive
 * account, an incomplete customer, and staff on the customer-only settings. Plus: the account is
 * always the one in the token (no IDOR), and editing the profile does not touch the session.
 *
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-001
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-014
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-016
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-018
 */

import { setupAuthHarness } from './helpers/fakeAuthModels.js';
import { makeCaller, makeCustomer, makeStaff, makeIncompleteCustomer } from './helpers/profileFixtures.js';

const h = await setupAuthHarness();
const call = makeCaller(h);
beforeEach(() => h.reset());

const URLS = [['get', '/api/v1/profile'], ['patch', '/api/v1/profile'], ['get', '/api/v1/profile/settings'], ['patch', '/api/v1/profile/settings']];

describe('authentication (AC-01, AC-02)', () => {
  test.each(URLS)('%s %s without a token → 401 and nothing is read', async (method, url) => {
    const res = await call(method, url).send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toMatch(/^TOKEN_/);
  });

  test.each(URLS)('%s %s with a garbage token → 401', async (method, url) => {
    expect((await call(method, url, 'not.a.token').send({})).status).toBe(401);
  });

  test('a revoked token (after logout) → 401', async () => {
    const { token } = await makeCustomer(h);
    expect((await call('post', '/api/v1/auth/logout', token)).status).toBe(200);
    expect((await call('get', '/api/v1/profile', token)).status).toBe(401);
  });

  test('a deactivated account → 401 ACCOUNT_INACTIVE', async () => {
    const { id, token } = await makeCustomer(h);
    h.stored(id).isActive = false;
    const res = await call('get', '/api/v1/profile', token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ACCOUNT_INACTIVE');
  });

  test.each(URLS)('an incomplete customer on %s %s → 403 PROFILE_INCOMPLETE', async (method, url) => {
    const { token } = await makeIncompleteCustomer(h);
    const res = await call(method, url, token).send({ fullName: 'An', marketingConsent: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PROFILE_INCOMPLETE');
  });

  test('no database write happens for a refused request', async () => {
    const { token } = await makeIncompleteCustomer(h);
    const before = JSON.stringify([...h.users.values()]);
    await call('patch', '/api/v1/profile', token).send({ fullName: 'Hacker' });
    expect(JSON.stringify([...h.users.values()])).toBe(before);
    expect(h.logs).toHaveLength(0);
  });
});

describe('roles (AC-21)', () => {
  test.each(['SALES_STAFF', 'ADMIN'])('%s on /profile/settings → 403 ROLE_INSUFFICIENT (GET and PATCH)', async (role) => {
    const { token } = await makeStaff(h, role);
    for (const [method, body] of [['get', undefined], ['patch', { marketingConsent: true }]]) {
      const res = await call(method, '/api/v1/profile/settings', token).send(body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ROLE_INSUFFICIENT');
    }
  });

  test('staff may read and edit the profile itself', async () => {
    const { token } = await makeStaff(h, 'ADMIN');
    expect((await call('get', '/api/v1/profile', token)).status).toBe(200);
    expect((await call('patch', '/api/v1/profile', token).send({ fullName: 'Quản Trị Viên' })).status).toBe(200);
  });
});

describe('no IDOR (AC-23)', () => {
  test('two customers see their own data, never each other\'s', async () => {
    const a = await makeCustomer(h, { fullName: 'Khách A', phone: '0901000001' });
    const b = await makeCustomer(h, { fullName: 'Khách B', phone: '0901000002' });
    const resA = await call('get', '/api/v1/profile', a.token);
    const resB = await call('get', '/api/v1/profile', b.token);
    expect(resA.body.data).toMatchObject({ id: a.id, fullName: 'Khách A', phone: '0901000001' });
    expect(resB.body.data).toMatchObject({ id: b.id, fullName: 'Khách B', phone: '0901000002' });
  });

  test('an id in the URL, query or body does not select another account', async () => {
    const a = await makeCustomer(h, { fullName: 'Khách A', phone: '0901000001' });
    const b = await makeCustomer(h, { fullName: 'Khách B', phone: '0901000002' });
    expect((await call('get', `/api/v1/profile?id=${b.id}`, a.token)).body.data.id).toBe(a.id);
    expect((await call('get', `/api/v1/profile/${b.id}`, a.token)).status).toBe(404); // there is no such route
    const res = await call('patch', '/api/v1/profile', a.token).send({ fullName: 'Đổi tên', id: b.id });
    expect(res.status).toBe(422); // unknown field
    expect(h.stored(b.id).fullName).toBe('Khách B');
  });

  test('a PATCH only ever changes the caller', async () => {
    const a = await makeCustomer(h, { fullName: 'Khách A', phone: '0901000001' });
    const b = await makeCustomer(h, { fullName: 'Khách B', phone: '0901000002' });
    await call('patch', '/api/v1/profile', a.token).send({ fullName: 'Khách A Mới' });
    expect(h.stored(b.id).fullName).toBe('Khách B');
    expect(h.customers.get(b.customerId).fullName).toBe('Khách B');
  });
});

describe('session (AC-25, REQ-018)', () => {
  test('editing the profile does not revoke the access token', async () => {
    const { token, id } = await makeCustomer(h);
    const before = h.stored(id).tokenVersion;
    expect((await call('patch', '/api/v1/profile', token).send({ fullName: 'Tên Mới' })).status).toBe(200);
    expect(h.stored(id).tokenVersion).toBe(before);
    expect((await call('get', '/api/v1/profile', token)).status).toBe(200); // the same token still works
    expect((await call('get', '/api/v1/auth/me', token)).status).toBe(200);
  });

  test('editing the settings does not revoke it either', async () => {
    const { token } = await makeCustomer(h);
    await call('patch', '/api/v1/profile/settings', token).send({ marketingConsent: true });
    expect((await call('get', '/api/v1/profile', token)).status).toBe(200);
  });
});
