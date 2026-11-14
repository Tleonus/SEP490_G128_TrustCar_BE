/**
 * @file profile-rollback.test.js
 * @description If the Customer write fails after the User was already saved, the User is put back
 * to its old values and the caller gets a generic 500, so the two records never end up different.
 *
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-009
 */

import { setupAuthHarness } from './helpers/fakeAuthModels.js';
import { makeCaller, makeCustomer } from './helpers/profileFixtures.js';

const h = await setupAuthHarness();
const { jest } = await import('@jest/globals');
const call = makeCaller(h);
beforeEach(() => h.reset());

const patch = (token, body) => call('patch', '/api/v1/profile', token).send(body);

describe('Customer write fails (AC-17)', () => {
  test('the User keeps its old name and the answer is a generic 500', async () => {
    const { token, id, customerId } = await makeCustomer(h, { fullName: 'Tên Cũ' });
    jest.spyOn(h.Customer, 'updateOne').mockRejectedValueOnce(new Error('db down'));
    const res = await patch(token, { fullName: 'Tên Mới' });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/db down|Tên/); // no internals, no personal data
    expect(h.stored(id).fullName).toBe('Tên Cũ');
    expect(h.customers.get(customerId).fullName).toBe('Tên Cũ');
  });

  test('both name and phone are restored together', async () => {
    const { token, id } = await makeCustomer(h, { fullName: 'Tên Cũ', phone: '0901111111' });
    jest.spyOn(h.Customer, 'updateOne').mockRejectedValueOnce(new Error('db down'));
    await patch(token, { fullName: 'Tên Mới', phone: '0907777777' });
    expect(h.stored(id)).toMatchObject({ fullName: 'Tên Cũ', phone: '0901111111' });
  });

  test('nothing is logged for a failed change', async () => {
    const { token } = await makeCustomer(h);
    jest.spyOn(h.Customer, 'updateOne').mockRejectedValueOnce(new Error('db down'));
    await patch(token, { fullName: 'Tên Mới' });
    expect(h.logs).toHaveLength(0);
  });

  test('the next attempt works normally (the restore left no trace)', async () => {
    const { token, id, customerId } = await makeCustomer(h, { fullName: 'Tên Cũ' });
    jest.spyOn(h.Customer, 'updateOne').mockRejectedValueOnce(new Error('db down'));
    expect((await patch(token, { fullName: 'Tên Mới' })).status).toBe(500);
    expect((await patch(token, { fullName: 'Tên Mới' })).status).toBe(200);
    expect(h.stored(id).fullName).toBe('Tên Mới');
    expect(h.customers.get(customerId).fullName).toBe('Tên Mới');
  });

  test('a change that only touches the Customer (gender) fails cleanly, the User is untouched', async () => {
    const { token, id } = await makeCustomer(h, { fullName: 'Giữ Nguyên' });
    jest.spyOn(h.Customer, 'updateOne').mockRejectedValueOnce(new Error('db down'));
    const userSpy = jest.spyOn(h.User, 'updateOne');
    userSpy.mockClear();
    expect((await patch(token, { gender: 'MALE' })).status).toBe(500);
    expect(userSpy).not.toHaveBeenCalled(); // nothing to compensate
    expect(h.stored(id).fullName).toBe('Giữ Nguyên');
  });
});

describe('the Customer vanished between the read and the write', () => {
  test('→ 404 CUSTOMER_NOT_FOUND and the User is restored', async () => {
    const { token, id } = await makeCustomer(h, { fullName: 'Tên Cũ' });
    jest.spyOn(h.Customer, 'updateOne').mockResolvedValueOnce({ acknowledged: true, matchedCount: 0, modifiedCount: 0 });
    const res = await patch(token, { fullName: 'Tên Mới' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
    expect(h.stored(id).fullName).toBe('Tên Cũ');
  });
});

describe('the compensation itself fails (R3)', () => {
  test('the caller still gets the generic 500, with no personal data in the log line', async () => {
    const { token } = await makeCustomer(h, { fullName: 'Tên Rất Riêng Tư' });
    jest.spyOn(h.Customer, 'updateOne').mockRejectedValueOnce(new Error('db down'));
    jest.spyOn(h.User, 'updateOne')
      .mockImplementationOnce((...args) => h.User.updateOne.getMockImplementation?.()?.(...args) ?? Promise.resolve({ matchedCount: 1 }))
      .mockRejectedValueOnce(new Error('db still down'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await patch(token, { fullName: 'Tên Mới' });
    expect(res.status).toBe(500);
    const logged = JSON.stringify(quiet.mock.calls);
    expect(logged).not.toMatch(/Riêng Tư|Tên Mới/);
    quiet.mockRestore(); // a console spy of ours, not a harness one
  });
});

describe('a failing first write changes nothing', () => {
  test('a User write error is mapped and nothing else is written', async () => {
    const { token, id, customerId } = await makeCustomer(h, { fullName: 'Tên Cũ' });
    jest.spyOn(h.User, 'updateOne').mockRejectedValueOnce(Object.assign(new Error('x'), { code: 11000, keyPattern: { phone: 1 } }));
    const customerSpy = jest.spyOn(h.Customer, 'updateOne');
    customerSpy.mockClear();
    const res = await patch(token, { fullName: 'Tên Mới', phone: '0907777777' });
    expect(res.status).toBe(409);
    expect(customerSpy).not.toHaveBeenCalled();
    expect(h.stored(id).fullName).toBe('Tên Cũ');
    expect(h.customers.get(customerId).fullName).toBe('Tên Cũ');
  });
});
