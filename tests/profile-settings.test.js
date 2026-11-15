/**
 * @file profile-settings.test.js
 * @description GET/PATCH /profile/settings: marketing consent defaults to false, can be switched
 * on and off, refuses bad bodies, writes nothing when nothing changes, and is logged without values.
 *
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-012
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-013
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-017
 */

import { setupAuthHarness } from './helpers/fakeAuthModels.js';
import { makeCaller, makeCustomer } from './helpers/profileFixtures.js';

const h = await setupAuthHarness();
const { jest } = await import('@jest/globals');
const call = makeCaller(h);
beforeEach(() => h.reset());

const get = (token) => call('get', '/api/v1/profile/settings', token);
const patch = (token, body) => call('patch', '/api/v1/profile/settings', token).send(body);

describe('read (AC-18)', () => {
  test('marketingConsent is false for a customer who never set it', async () => {
    const { token } = await makeCustomer(h);
    const res = await get(token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ marketingConsent: false });
  });

  test('returns exactly one key', async () => {
    const { token } = await makeCustomer(h, { customer: { marketingConsent: true, notes: 'x' } });
    expect(Object.keys((await get(token)).body.data)).toEqual(['marketingConsent']);
  });

  test('a customer without a Customer record → 404 CUSTOMER_NOT_FOUND (AC-22)', async () => {
    const { token, customerId } = await makeCustomer(h);
    h.customers.delete(customerId);
    const res = await get(token);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
  });
});

describe('write (AC-19)', () => {
  test('switching it on and off is stored on the Customer and read back', async () => {
    const { token, customerId } = await makeCustomer(h);
    const on = await patch(token, { marketingConsent: true });
    expect(on.status).toBe(200);
    expect(on.body.data).toEqual({ marketingConsent: true });
    expect(h.customers.get(customerId).marketingConsent).toBe(true);
    expect((await get(token)).body.data.marketingConsent).toBe(true);

    const off = await patch(token, { marketingConsent: false });
    expect(off.body.data).toEqual({ marketingConsent: false });
    expect(h.customers.get(customerId).marketingConsent).toBe(false);
  });

  test('records who changed it (updatedBy)', async () => {
    const { token, customerId, id } = await makeCustomer(h);
    await patch(token, { marketingConsent: true });
    expect(String(h.customers.get(customerId).updatedBy)).toBe(String(id));
  });

  test('does not touch the User record', async () => {
    const { token, id } = await makeCustomer(h);
    const before = JSON.stringify(h.stored(id));
    await patch(token, { marketingConsent: true });
    expect(JSON.stringify(h.stored(id))).toBe(before);
  });
});

describe('bad bodies → 422 and nothing is written (AC-20)', () => {
  test.each([
    [{}], [{ marketingConsent: 'yes' }], [{ marketingConsent: 'true' }], [{ marketingConsent: 1 }], [{ marketingConsent: null }],
    [{ marketingConsent: true, extra: 1 }], [{ fullName: 'Hacker' }], [{ email: 'x@y.vn' }],
  ])('%j', async (body) => {
    const { token, customerId } = await makeCustomer(h);
    const res = await patch(token, body);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(h.customers.get(customerId).marketingConsent).toBe(false); // the schema default, untouched
    expect(h.logs).toHaveLength(0);
  });
});

describe('no change → no write, no log (C17)', () => {
  test('sending the current value answers 200 and does nothing', async () => {
    const { token } = await makeCustomer(h, { customer: { marketingConsent: true } });
    const spy = jest.spyOn(h.Customer, 'updateOne');
    spy.mockClear(); // the harness already spies on it: count only this request
    const res = await patch(token, { marketingConsent: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ marketingConsent: true });
    expect(spy).not.toHaveBeenCalled();
    expect(h.logs).toHaveLength(0);
  });

  test('false on a customer that never set it is also "no change"', async () => {
    const { token, customerId } = await makeCustomer(h);
    expect((await patch(token, { marketingConsent: false })).status).toBe(200);
    expect(h.customers.get(customerId).marketingConsent).toBe(false); // the schema default, untouched
    expect(h.logs).toHaveLength(0);
  });
});

describe('audit log (AC-24)', () => {
  test('a real change logs SETTINGS_UPDATED with the field name and no value', async () => {
    const { token, id } = await makeCustomer(h);
    await patch(token, { marketingConsent: true });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ eventType: 'SETTINGS_UPDATED', targetModel: 'User', summary: 'Settings updated: marketingConsent' });
    expect(String(h.logs[0].performedBy)).toBe(String(id));
    expect(JSON.stringify(h.logs[0])).not.toMatch(/true/);
  });
});
