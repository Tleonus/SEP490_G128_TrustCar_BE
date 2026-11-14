/**
 * @file profile-update.test.js
 * @description PATCH /profile: what is saved, in both records, for customers and staff; every
 * refusal (422) writes nothing; a no-op writes nothing; the audit log names fields, never values.
 *
 * NOTE: never `mockRestore()` a spy the harness installed (it would restore the REAL model method).
 *
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-004
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-005
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-006
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-011
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-017
 */

import { setupAuthHarness } from './helpers/fakeAuthModels.js';
import { makeCaller, makeCustomer, makeStaff } from './helpers/profileFixtures.js';

const h = await setupAuthHarness();
const { jest } = await import('@jest/globals');
const call = makeCaller(h);
beforeEach(() => h.reset());

const patch = (token, body) => call('patch', '/api/v1/profile', token).send(body);
const snapshot = () => JSON.stringify({ users: [...h.users.values()], customers: [...h.customers.values()] });

describe('a customer edits the profile', () => {
  test('the name is trimmed and saved in BOTH records (AC-05)', async () => {
    const { token, id, customerId } = await makeCustomer(h);
    const res = await patch(token, { fullName: '  Nguyễn Văn A ' });
    expect(res.status).toBe(200);
    expect(res.body.data.fullName).toBe('Nguyễn Văn A');
    expect(h.stored(id).fullName).toBe('Nguyễn Văn A');
    expect(h.customers.get(customerId).fullName).toBe('Nguyễn Văn A');
  });

  test('a partial address only changes the sub-fields that were sent (AC-10)', async () => {
    const { token, customerId } = await makeCustomer(h, { customer: { address: { street: '1 Lê Lợi', district: 'Q1', province: 'HCM' } } });
    const res = await patch(token, { address: { city: 'Hà Nội' } });
    expect(res.status).toBe(200);
    expect(res.body.data.address).toEqual({ street: '1 Lê Lợi', district: 'Q1', city: 'Hà Nội', province: 'HCM' });
    expect(h.customers.get(customerId).address).toMatchObject({ street: '1 Lê Lợi', city: 'Hà Nội' });
  });

  test('an empty string clears an address field (AC-11)', async () => {
    const { token } = await makeCustomer(h, { customer: { address: { street: '1 Lê Lợi', city: 'Huế' } } });
    const res = await patch(token, { address: { street: '' } });
    expect(res.body.data.address).toMatchObject({ street: null, city: 'Huế' });
  });

  test('null also clears it, and the whole address can be cleared field by field', async () => {
    const { token } = await makeCustomer(h, { customer: { address: { street: 'a', district: 'b', city: 'c', province: 'd' } } });
    const res = await patch(token, { address: { street: null, district: '', city: null, province: '' } });
    expect(res.body.data.address).toEqual({ street: null, district: null, city: null, province: null });
  });

  test('date of birth and gender are saved and returned (AC-13)', async () => {
    const { token, customerId } = await makeCustomer(h);
    const res = await patch(token, { dateOfBirth: '2000-05-20', gender: 'FEMALE' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ dateOfBirth: '2000-05-20', gender: 'FEMALE' });
    expect(h.customers.get(customerId).dateOfBirth.toISOString()).toBe('2000-05-20T00:00:00.000Z');
  });

  test('both can be cleared with null', async () => {
    const { token } = await makeCustomer(h, { customer: { dateOfBirth: new Date('2000-05-20T00:00:00Z'), gender: 'MALE' } });
    const res = await patch(token, { dateOfBirth: null, gender: null });
    expect(res.body.data).toMatchObject({ dateOfBirth: null, gender: null });
  });

  test('records who edited (Customer.updatedBy)', async () => {
    const { token, id, customerId } = await makeCustomer(h);
    await patch(token, { gender: 'OTHER' });
    expect(String(h.customers.get(customerId).updatedBy)).toBe(String(id));
  });

  test('fields that were not sent stay as they were', async () => {
    const { token, id, customerId } = await makeCustomer(h, { fullName: 'Giữ Nguyên', customer: { gender: 'MALE' } });
    await patch(token, { dateOfBirth: '1990-01-01' });
    expect(h.stored(id).fullName).toBe('Giữ Nguyên');
    expect(h.customers.get(customerId)).toMatchObject({ fullName: 'Giữ Nguyên', gender: 'MALE' });
  });

  test('the answer is the profile AFTER the change (same DTO as GET)', async () => {
    const { token } = await makeCustomer(h);
    const res = await patch(token, { fullName: 'Tên Mới' });
    const get = await call('get', '/api/v1/profile', token);
    expect(res.body.data).toEqual(get.body.data);
  });
});

describe('refusals write nothing (AC-12, 14, 16)', () => {
  test.each([
    [{}], [{ email: 'x@y.vn' }], [{ role: 'ADMIN' }], [{ password: 'Abcdef12' }], [{ avatar: 'x' }], [{ whatever: 1 }],
    [{ phone: '' }], [{ fullName: 'A' }], [{ fullName: '' }],
    [{ dateOfBirth: '2999-01-01' }], [{ dateOfBirth: '1800-01-01' }], [{ dateOfBirth: 'abc' }], [{ dateOfBirth: '2000-02-31' }],
    [{ gender: 'male' }], [{ address: { street: 'x'.repeat(201) } }], [{ address: {} }],
  ])('%j → 422, no write, no log', async (body) => {
    const { token } = await makeCustomer(h);
    const before = snapshot();
    const res = await patch(token, body);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(snapshot()).toBe(before);
    expect(h.logs).toHaveLength(0);
  });

  test('the error names the offending fields', async () => {
    const { token } = await makeCustomer(h);
    const res = await patch(token, { fullName: 'A', gender: 'X' });
    expect(res.body.errors.map((e) => e.field).sort()).toEqual(['fullName', 'gender']);
  });
});

describe('staff (AC-15, REQ-006)', () => {
  test.each([['gender', { gender: 'MALE' }], ['dateOfBirth', { dateOfBirth: '2000-01-01' }], ['address', { address: { city: 'x' } }]])(
    'sending %s → 422 naming it, nothing written', async (field, body) => {
      const { token } = await makeStaff(h, 'SALES_STAFF');
      const before = snapshot();
      const res = await patch(token, body);
      expect(res.status).toBe(422);
      expect(res.body.errors.map((e) => e.field)).toEqual([field]);
      expect(snapshot()).toBe(before);
    },
  );

  test('a staff name change → 200 and only the User is written', async () => {
    const { token, id } = await makeStaff(h, 'SALES_STAFF');
    const res = await patch(token, { fullName: 'Tên Mới' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ fullName: 'Tên Mới', address: null, editableFields: ['fullName', 'phone'] });
    expect(h.stored(id).fullName).toBe('Tên Mới');
    expect(h.customers.size).toBe(0);
  });

  test('a staff phone change works (staff phones are not unique-checked against customers)', async () => {
    const { token } = await makeStaff(h, 'ADMIN');
    expect((await patch(token, { phone: '+84911000222' })).body.data.phone).toBe('0911000222');
  });
});

describe('no change → no write, no log (C17)', () => {
  test('sending the stored values answers 200 and does nothing', async () => {
    const { token } = await makeCustomer(h, { fullName: 'Nguyễn An', phone: '0901234567', customer: { gender: 'MALE', address: { city: 'Huế' } } });
    const userSpy = jest.spyOn(h.User, 'updateOne');
    const customerSpy = jest.spyOn(h.Customer, 'updateOne');
    userSpy.mockClear();
    customerSpy.mockClear();
    const before = snapshot();
    const res = await patch(token, { fullName: 'Nguyễn An', phone: '0901234567', gender: 'MALE', address: { city: 'Huế', street: '' } });
    expect(res.status).toBe(200);
    expect(userSpy).not.toHaveBeenCalled();
    expect(customerSpy).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
    expect(h.logs).toHaveLength(0);
  });
});

describe('audit log (AC-24)', () => {
  test('lists the NAMES of what changed, never the values', async () => {
    const { token, id } = await makeCustomer(h);
    await patch(token, { fullName: 'Họ Tên Rất Riêng Tư', phone: '0907654321', address: { street: 'Số 7 Đường Bí Mật' }, dateOfBirth: '1991-02-03', gender: 'FEMALE' });
    expect(h.logs).toHaveLength(1);
    const [entry] = h.logs;
    expect(entry).toMatchObject({ eventType: 'PROFILE_UPDATED', targetModel: 'User' });
    expect(entry.summary).toBe('Profile updated: fullName, phone, address, dateOfBirth, gender');
    expect(String(entry.performedBy)).toBe(String(id));
    expect(JSON.stringify(entry)).not.toMatch(/Riêng Tư|0907654321|Bí Mật|1991|FEMALE/);
  });

  test('one log per change, only for what changed', async () => {
    const { token } = await makeCustomer(h, { customer: { gender: 'MALE' } });
    await patch(token, { gender: 'FEMALE', fullName: 'Nguyễn An' });
    expect(h.logs.map((l) => l.summary)).toEqual(['Profile updated: gender']);
  });
});
