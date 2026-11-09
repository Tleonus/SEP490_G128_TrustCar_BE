/**
 * @file user-role-assignment.test.js
 * @description KAN-36: an admin assigns a role, the change is audited, and the
 * target's existing sessions stop working immediately.
 */

import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
const { updateUser } = await import('../src/services/userService.js');
const { login } = await import('../src/services/authService.js');
const { verifyTokenOfType, isTokenCurrent } = await import('../src/utils/authTokens.js');
const { default: User } = await import('../src/models/User.js');

const signIn = (email) => login({ email, password: 'TrustCar2026', ipAddress: '127.0.0.1' });

/** Whether a token issued earlier still matches the user's stored tokenVersion. */
const sessionStillValid = async (accessToken, userId) => {
  const decoded = verifyTokenOfType(accessToken, 'access');
  const stored = await User.findById(userId).select('+tokenVersion');
  return isTokenCurrent(decoded, stored);
};

beforeEach(() => h.reset());

let admin;

beforeEach(async () => {
  admin = await h.createUser({ roleName: 'ADMIN', email: 'admin@trustcar.vn' });
});

test('assigns a new role and records who held which role before', async () => {
  const staff = await h.createUser({ roleName: 'SALES_STAFF', email: 'sales@trustcar.vn' });

  const updated = await updateUser({
    userId: staff.id,
    updates: {},
    newRoleName: 'ADMIN',
    updatedByUserId: admin.id,
    ipAddress: admin.ipAddress,
  });

  expect(updated.roleName).toBe('ADMIN');
  expect(String(updated.role)).toBe(String(h.roleIds.ADMIN));

  const audit = h.logs.find((entry) => entry.targetId && String(entry.targetId) === staff.id);
  expect(audit.changes.before.roleName).toBe('SALES_STAFF');
  expect(audit.changes.after.roleName).toBe('ADMIN');
});

test('an unchanged role leaves existing sessions valid', async () => {
  const staff = await h.createUser({ roleName: 'SALES_STAFF', email: 'sales@trustcar.vn' });
  const { accessToken } = await signIn('sales@trustcar.vn');

  await updateUser({ userId: staff.id, updates: { fullName: 'Moi Ten' }, updatedByUserId: admin.id });

  expect(await sessionStillValid(accessToken, staff.id)).toBe(true);
});

test('assigning a role revokes sessions issued under the old role', async () => {
  const staff = await h.createUser({ roleName: 'SALES_STAFF', email: 'sales2@trustcar.vn' });
  const { accessToken } = await signIn('sales2@trustcar.vn');

  await updateUser({ userId: staff.id, updates: {}, newRoleName: 'ADMIN', updatedByUserId: admin.id });

  expect(await sessionStillValid(accessToken, staff.id)).toBe(false);
});

test('a customer account cannot be promoted to staff', async () => {
  const customer = await h.createUser({ roleName: 'CUSTOMER', email: 'khach@trustcar.vn' });

  await expect(updateUser({
    userId: customer.id, updates: {}, newRoleName: 'SALES_STAFF', updatedByUserId: admin.id,
  })).rejects.toMatchObject({ statusCode: 422 });

  expect(h.users.get(customer.id).roleName).toBe('CUSTOMER');
});

test('an unknown role is rejected and changes nothing', async () => {
  const staff = await h.createUser({ roleName: 'SALES_STAFF' });

  await expect(updateUser({
    userId: staff.id, updates: {}, newRoleName: 'MANAGER', updatedByUserId: admin.id,
  })).rejects.toMatchObject({ code: 'ROLE_NOT_FOUND' });

  expect(h.users.get(staff.id).roleName).toBe('SALES_STAFF');
});
