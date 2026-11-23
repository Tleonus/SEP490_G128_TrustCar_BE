/**
 * @file rbac-multi-role.test.js
 * @description KAN-93 / KAN-94 — multi-role RBAC.
 *
 * Covers:
 * - updateUserRoles: validation, CUSTOMER guards, primary-role mirroring,
 *   session revocation, audit trail.
 * - requirePermission / requireRole / authorizeRoles: union of permissions
 *   across every role a user holds.
 * - INSPECTOR: inspection routes reachable through inspection:*
 *   permissions instead of a hard-coded role list.
 */

import request from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
const api = () => request(h.app);
const as = (token) => ({ Authorization: `Bearer ${token}` });

const { updateUserRoles } = await import('../src/services/userService.js');
const { login } = await import('../src/services/authService.js');
const { verifyTokenOfType, isTokenCurrent } = await import('../src/utils/authTokens.js');
const { default: User } = await import('../src/models/User.js');
const { Roles, ROLE_PERMISSIONS, Permissions } = await import('../src/constants/appConstants.js');
const { default: Role } = await import('../src/models/Role.js');

beforeEach(() => h.reset());

const signIn = (email) => login({ email, password: 'TrustCar2026', ipAddress: '127.0.0.1' });

/** Access token for a freshly created user, bypassing the login rate limiter. */
const tokenFor = async (overrides) => {
  const { id, email } = await h.createUser(overrides);
  const { accessToken } = await signIn(email);
  return { id, email, token: accessToken };
};

const sessionStillValid = async (accessToken, userId) => {
  const decoded = verifyTokenOfType(accessToken, 'access');
  const stored = await User.findById(userId).select('+tokenVersion');
  return isTokenCurrent(decoded, stored);
};

// ═══════════════════════════════════════════════════════════════════════════
// updateUserRoles — service level
// ═══════════════════════════════════════════════════════════════════════════

describe('updateUserRoles', () => {
  let admin;
  beforeEach(async () => {
    admin = await h.createUser({ roleName: 'ADMIN', email: 'admin@trustcar.vn' });
  });

  // Role.find / Role.findOne are stubbed by the harness for the default roles.
  // For the service tests we stub Role.find to resolve the ids we pass in.
  const stubRoleFind = (names) => {
    const original = Role.find;
    Role.find = async (filter) => {
      const ids = filter?._id?.$in || [];
      return ids
        .map((id) => {
          const name = Object.keys(h.roleIds).find((n) => String(h.roleIds[n]) === String(id));
          return name ? { _id: h.roleIds[name], name, isActive: true } : null;
        })
        .filter((r) => r && (!names || names.includes(r.name)));
    };
    return () => { Role.find = original; };
  };

  test('sets both roles, mirrors the primary one and keeps the request order', async () => {
    const staff = await h.createUser({ roleName: 'SALES_STAFF', email: 'sales@trustcar.vn' });
    const restore = stubRoleFind();
    try {
      const updated = await updateUserRoles({
        userId: staff.id,
        roleIds: [String(h.roleIds.INSPECTOR), String(h.roleIds.SALES_STAFF)],
        updatedByUserId: admin.id,
        ipAddress: '127.0.0.1',
      });

      expect(updated.roleNames).toEqual([Roles.INSPECTOR, Roles.SALES_STAFF]);
      expect(updated.roleName).toBe(Roles.INSPECTOR);          // primary = first
      expect(String(updated.role)).toBe(String(h.roleIds.INSPECTOR));
      expect(updated.roles.map(String)).toEqual([
        String(h.roleIds.INSPECTOR), String(h.roleIds.SALES_STAFF),
      ]);

      const stored = h.stored(staff.id);
      expect(stored.roleNames).toEqual([Roles.INSPECTOR, Roles.SALES_STAFF]);
      expect(String(stored.role)).toBe(String(h.roleIds.INSPECTOR));
    } finally { restore(); }
  });

  test('rejects an empty role list', async () => {
    const staff = await h.createUser({ roleName: 'SALES_STAFF' });
    await expect(updateUserRoles({
      userId: staff.id, roleIds: [], updatedByUserId: admin.id,
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects unknown role ids', async () => {
    const staff = await h.createUser({ roleName: 'SALES_STAFF' });
    const restore = stubRoleFind();
    try {
      await expect(updateUserRoles({
        userId: staff.id,
        roleIds: [String(h.roleIds.INSPECTOR), '507f1f77bcf86cd799439011'],
        updatedByUserId: admin.id,
      })).rejects.toMatchObject({ statusCode: 400 });
    } finally { restore(); }
  });

  test('rejects a mix of CUSTOMER and staff roles', async () => {
    const staff = await h.createUser({ roleName: 'SALES_STAFF' });
    const restore = stubRoleFind();
    try {
      await expect(updateUserRoles({
        userId: staff.id,
        roleIds: [String(h.roleIds.CUSTOMER), String(h.roleIds.SALES_STAFF)],
        updatedByUserId: admin.id,
      })).rejects.toMatchObject({ statusCode: 409 });
    } finally { restore(); }
  });

  test('refuses to make a staff account a CUSTOMER', async () => {
    const staff = await h.createUser({ roleName: 'SALES_STAFF' });
    const restore = stubRoleFind();
    try {
      await expect(updateUserRoles({
        userId: staff.id,
        roleIds: [String(h.roleIds.CUSTOMER)],
        updatedByUserId: admin.id,
      })).rejects.toMatchObject({ statusCode: 409 });
    } finally { restore(); }
  });

  test('revokes existing sessions so the new role set applies immediately', async () => {
    const staff = await h.createUser({ roleName: 'SALES_STAFF', email: 'sales2@trustcar.vn' });
    const { accessToken } = await signIn('sales2@trustcar.vn');
    const restore = stubRoleFind();
    try {
      await updateUserRoles({
        userId: staff.id,
        roleIds: [String(h.roleIds.SALES_STAFF), String(h.roleIds.INSPECTOR)],
        updatedByUserId: admin.id,
      });
      expect(await sessionStillValid(accessToken, staff.id)).toBe(false);
    } finally { restore(); }
  });

  test('writes an audit entry with the before and after role sets', async () => {
    const staff = await h.createUser({ roleName: 'SALES_STAFF', email: 'sales3@trustcar.vn' });
    const restore = stubRoleFind();
    try {
      await updateUserRoles({
        userId: staff.id,
        roleIds: [String(h.roleIds.SALES_STAFF), String(h.roleIds.INSPECTOR)],
        updatedByUserId: admin.id,
      });

      const audit = h.logs.find((e) => e.targetId && String(e.targetId) === staff.id);
      expect(audit.changes.before.roleNames).toEqual([Roles.SALES_STAFF]);
      expect(audit.changes.after.roleNames).toEqual([Roles.SALES_STAFF, Roles.INSPECTOR]);
    } finally { restore(); }
  });

  test('404 for an unknown user', async () => {
    await expect(updateUserRoles({
      userId: '507f1f77bcf86cd799439011',
      roleIds: [String(h.roleIds.SALES_STAFF)],
      updatedByUserId: admin.id,
    })).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PUT /users/:id/roles — HTTP contract
// ═══════════════════════════════════════════════════════════════════════════

describe('PUT /api/v1/users/:id/roles', () => {
  const stubRoleFind = () => {
    const original = Role.find;
    Role.find = async (filter) => {
      const ids = filter?._id?.$in || [];
      return ids
        .map((id) => {
          const name = Object.keys(h.roleIds).find((n) => String(h.roleIds[n]) === String(id));
          return name ? { _id: h.roleIds[name], name, isActive: true } : null;
        })
        .filter(Boolean);
    };
    return () => { Role.find = original; };
  };

  test('admin replaces the role set → 200 and the response echoes roleNames', async () => {
    const { token: adminToken } = await tokenFor({ roleName: 'ADMIN' });
    const staff = await h.createUser({ roleName: 'SALES_STAFF' });
    const restore = stubRoleFind();

    try {
      const res = await api()
        .put(`/api/v1/users/${staff.id}/roles`)
        .set(as(adminToken))
        .send({ roleIds: [String(h.roleIds.SALES_STAFF), String(h.roleIds.INSPECTOR)] });

      expect(res.status).toBe(200);
      expect(res.body.data.roleNames).toEqual([Roles.SALES_STAFF, Roles.INSPECTOR]);
      expect(res.body.data.roleName).toBe(Roles.SALES_STAFF);
      expect(h.stored(staff.id).roleNames).toEqual([Roles.SALES_STAFF, Roles.INSPECTOR]);
    } finally { restore(); }
  });

  test('an empty roleIds array → 422 (validation)', async () => {
    const { token: adminToken } = await tokenFor({ roleName: 'ADMIN' });
    const staff = await h.createUser({ roleName: 'SALES_STAFF' });

    const res = await api()
      .put(`/api/v1/users/${staff.id}/roles`)
      .set(as(adminToken))
      .send({ roleIds: [] });

    expect(res.status).toBe(422);
    expect(h.stored(staff.id).roleNames).toEqual([Roles.SALES_STAFF]);
  });

  test('a non-admin caller → 403', async () => {
    const { token: staffToken } = await tokenFor({ roleName: 'SALES_STAFF' });
    const target = await h.createUser({ roleName: 'SALES_STAFF' });

    const res = await api()
      .put(`/api/v1/users/${target.id}/roles`)
      .set(as(staffToken))
      .send({ roleIds: [String(h.roleIds.INSPECTOR)] });

    expect(res.status).toBe(403);
  });

  test('a malformed role id → 422 without touching the user', async () => {
    const { token: adminToken } = await tokenFor({ roleName: 'ADMIN' });
    const staff = await h.createUser({ roleName: 'SALES_STAFF' });

    const res = await api()
      .put(`/api/v1/users/${staff.id}/roles`)
      .set(as(adminToken))
      .send({ roleIds: ['not-an-object-id'] });

    expect(res.status).toBe(422);
    expect(h.stored(staff.id).roleNames).toEqual([Roles.SALES_STAFF]);
  });

  test('GET /users?roles=INSPECTOR filters by any held role', async () => {
    const { token: adminToken } = await tokenFor({ roleName: 'ADMIN' });
    await h.createUser({ roleName: 'SALES_STAFF', email: 'plain-sales@trustcar.vn' });
    const inspector = await h.createUser({
      roleName: 'SALES_STAFF', roleNames: [Roles.SALES_STAFF, Roles.INSPECTOR],
      email: 'inspector@trustcar.vn',
    });

    // The harness only stubs findOne/findById; userService.getUsers uses find().
    const originalFind = User.find;
    const originalCount = User.countDocuments;
    User.find = (filter = {}) => {
      const wanted = filter.roleNames?.$in || [];
      const rows = [...h.users.values()].filter((u) =>
        !wanted.length || wanted.some((r) => (u.roleNames || []).includes(r)));
      const chain = {
        populate: () => chain, select: () => chain, sort: () => chain,
        skip: () => chain, limit: () => chain, lean: () => chain,
        then: (ok, ko) => Promise.resolve(rows).then(ok, ko),
      };
      return chain;
    };
    User.countDocuments = async () => 1;

    try {
      const res = await api()
        .get('/api/v1/users?roles=INSPECTOR')
        .set(as(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.map((u) => u._id)).toContain(inspector.id);
      expect(res.body.data.every((u) => u.roleNames.includes(Roles.INSPECTOR))).toBe(true);
    } finally {
      User.find = originalFind;
      User.countDocuments = originalCount;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Union permissions through the real middleware chain
// ═══════════════════════════════════════════════════════════════════════════

describe('permission union across roles', () => {
  test('SALES_STAFF holds the inspection permissions seeded for it', () => {
    expect(ROLE_PERMISSIONS[Roles.SALES_STAFF]).toEqual(expect.arrayContaining([
      Permissions.INSPECTION_READ, Permissions.INSPECTION_WRITE,
    ]));
  });

  test('INSPECTOR holds inspection permissions but not sales ones', () => {
    const perms = ROLE_PERMISSIONS[Roles.INSPECTOR];
    expect(perms).toEqual(expect.arrayContaining([
      Permissions.INSPECTION_READ, Permissions.INSPECTION_WRITE, Permissions.CAR_READ,
    ]));
    expect(perms).not.toContain(Permissions.INSPECTION_ADMIN);
    expect(perms).not.toContain(Permissions.LEAD_CREATE);
    expect(perms).not.toContain(Permissions.USER_CREATE);
  });

  test('ADMIN holds inspection:admin', () => {
    expect(ROLE_PERMISSIONS[Roles.ADMIN]).toContain(Permissions.INSPECTION_ADMIN);
  });

  test('a user with both SALES_STAFF and INSPECTOR gets the union', async () => {
    const { requirePermission, requireRole, authorizeRoles } =
      await import('../src/middlewares/roleMiddleware.js');

    const union = Array.from(new Set([
      ...ROLE_PERMISSIONS[Roles.SALES_STAFF],
      ...ROLE_PERMISSIONS[Roles.INSPECTOR],
    ]));

    const req = {
      user: { roleName: Roles.SALES_STAFF },
      userRoleNames: [Roles.SALES_STAFF, Roles.INSPECTOR],
      userPermissions: union,
      params: {},
    };

    // A sales-only permission and an inspection permission both pass.
    for (const perm of [Permissions.LEAD_CREATE, Permissions.INSPECTION_WRITE]) {
      const err = await new Promise((resolve) => requirePermission(perm)(req, {}, resolve));
      expect(err).toBeUndefined();
    }

    // requireRole matches the secondary role too.
    const roleErr = await new Promise((resolve) => requireRole(Roles.INSPECTOR)(req, {}, resolve));
    expect(roleErr).toBeUndefined();

    const authErr = await new Promise((resolve) => authorizeRoles(Roles.INSPECTOR)(req, {}, resolve));
    expect(authErr).toBeUndefined();
  });

  test('a role the user does not hold is still refused', async () => {
    const { requirePermission, requireRole } = await import('../src/middlewares/roleMiddleware.js');

    const req = {
      user: { roleName: Roles.SALES_STAFF },
      userRoleNames: [Roles.SALES_STAFF],
      userPermissions: ROLE_PERMISSIONS[Roles.SALES_STAFF],
      params: {},
    };

    const permErr = await new Promise((resolve) =>
      requirePermission(Permissions.INSPECTION_ADMIN)(req, {}, resolve));
    expect(permErr).toMatchObject({ statusCode: 403 });

    const roleErr = await new Promise((resolve) =>
      requireRole(Roles.ADMIN)(req, {}, resolve));
    expect(roleErr).toMatchObject({ statusCode: 403 });
  });
});
