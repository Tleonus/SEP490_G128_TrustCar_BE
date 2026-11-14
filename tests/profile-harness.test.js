/**
 * @file profile-harness.test.js
 * @description Proves the in-memory auth harness is enough for the profile feature:
 * dotted `$set` paths on Customer, the unique customer phone on User, and a failing
 * Customer write that tests can force (for the compensation test).
 *
 * @ears .sdd/features/user-profile-settings/PLAN.md#8
 */

import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
const { jest } = await import('@jest/globals');
beforeEach(() => h.reset());

describe('Customer.updateOne', () => {
  test('writes a dotted path (address.city) and leaves the other address fields alone', async () => {
    const id = await h.createCustomer({ address: { street: '1 Lê Lợi', city: 'Huế' } });
    await h.Customer.updateOne({ _id: id }, { $set: { 'address.city': 'Hà Nội' } });
    const stored = h.customers.get(id);
    expect(stored.address).toMatchObject({ street: '1 Lê Lợi', city: 'Hà Nội' });
  });

  test('can set several paths at once, including a Date and updatedBy', async () => {
    const id = await h.createCustomer();
    const dob = new Date('2000-05-20T00:00:00.000Z');
    await h.Customer.updateOne({ _id: id }, { $set: { dateOfBirth: dob, gender: 'FEMALE', updatedBy: 'u1' } });
    expect(h.customers.get(id)).toMatchObject({ gender: 'FEMALE', updatedBy: 'u1' });
    expect(h.customers.get(id).dateOfBirth.getTime()).toBe(dob.getTime());
  });

  test('reports matchedCount 0 for an unknown customer', async () => {
    const result = await h.Customer.updateOne({ _id: '000000000000000000000000' }, { $set: { gender: 'MALE' } });
    expect(result.matchedCount).toBe(0);
  });

  test('can be overridden to throw, so a test can force the second write to fail', async () => {
    const id = await h.createCustomer();
    const spy = jest.spyOn(h.Customer, 'updateOne').mockRejectedValueOnce(new Error('db down'));
    await expect(h.Customer.updateOne({ _id: id }, { $set: { gender: 'MALE' } })).rejects.toThrow('db down');
  });
});

describe('User unique customer phone', () => {
  const customer = (phone) => h.createUser({ roleName: 'CUSTOMER', phone });

  test('a second customer taking an existing phone throws E11000 with keyPattern.phone', async () => {
    await customer('0901111111');
    const { id } = await customer('0902222222');
    let error;
    try { await h.User.updateOne({ _id: id }, { $set: { phone: '0901111111' } }); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 11000, keyPattern: { phone: 1 } });
    expect(h.stored(id).phone).toBe('0902222222'); // unchanged
  });

  test('a customer re-saving their own phone is not a clash', async () => {
    const { id } = await customer('0903333333');
    await expect(h.User.updateOne({ _id: id }, { $set: { phone: '0903333333' } })).resolves.toMatchObject({ matchedCount: 1 });
  });

  test('a staff account may share a phone with a customer (the index covers customers only)', async () => {
    await customer('0904444444');
    const { id } = await h.createUser({ roleName: 'SALES_STAFF', phone: '0911000000' });
    await expect(h.User.updateOne({ _id: id }, { $set: { phone: '0904444444' } })).resolves.toMatchObject({ matchedCount: 1 });
  });

  test('User.exists can look for another customer with a phone', async () => {
    const { id } = await customer('0905555555');
    const { id: other } = await customer('0906666666');
    const clash = await h.User.exists({ roleName: 'CUSTOMER', phone: '0905555555', _id: { $ne: other } });
    expect(clash).not.toBeNull();
    expect(await h.User.exists({ roleName: 'CUSTOMER', phone: '0905555555', _id: { $ne: id } })).toBeNull();
  });
});

describe('ActivityLog', () => {
  test('ActivityLog.log writes to the in-memory list', async () => {
    const { default: ActivityLog } = await import('../src/models/ActivityLog.js');
    await ActivityLog.log({ eventType: 'X', summary: 'y' });
    expect(h.logs).toHaveLength(1);
  });
});

describe('new activity event types (T004)', () => {
  test('ActivityEventType has PROFILE_UPDATED and SETTINGS_UPDATED, and ActivityLog accepts them', async () => {
    const { ActivityEventType } = await import('../src/constants/appConstants.js');
    const { default: ActivityLog } = await import('../src/models/ActivityLog.js');
    expect(Object.values(ActivityEventType)).toEqual(expect.arrayContaining(['PROFILE_UPDATED', 'SETTINGS_UPDATED']));
    for (const eventType of ['PROFILE_UPDATED', 'SETTINGS_UPDATED']) {
      const error = new ActivityLog({ eventType, targetModel: 'User', summary: 's' }).validateSync();
      expect(error?.errors?.eventType).toBeUndefined();
    }
  });
});
