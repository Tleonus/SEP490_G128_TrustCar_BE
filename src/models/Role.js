/**
 * @file Role.js
 * @description Dynamic Role model storing named roles and their permission sets.
 * Seeded with ADMIN and SALES_STAFF roles on first startup.
 *
 * Ref: FE-12, FE-13, GBR-02, GBR-03
 */

import mongoose from 'mongoose';
import { Roles, Permissions } from '../constants/appConstants.js';

const RoleSchema = new mongoose.Schema(
  {
    name: {
      type:      String,
      required:  [true, 'Role name is required.'],
      unique:    true,
      uppercase: true,
      trim:      true,
      enum:      {
        values:  Object.values(Roles),
        message: 'Role must be one of: ' + Object.values(Roles).join(', '),
      },
    },

    description: {
      type:    String,
      trim:    true,
      maxlength: 500,
    },

    permissions: {
      type:    [String],
      default: [],
      validate: {
        validator: (arr) => arr.every((p) => Object.values(Permissions).includes(p)),
        message:   'One or more permissions are invalid.',
      },
    },

    isActive: {
      type:    Boolean,
      default: true,
    },
  },
  {
    timestamps:  true,
    versionKey:  false,
    collection:  'roles',
  }
);

// Index for fast role lookup by name
RoleSchema.index({ name: 1 });

// ── Static Seed Helper ─────────────────────────────────────────────────────
/**
 * Seeds the database with the default roles if they don't already exist.
 * Called from server.js after DB connects.
 *
 * KAN-93/KAN-94: also re-syncs permissions on existing default roles and
 * reactivates them. Permissions are read from the DB Role documents at request
 * time, so a role that was seeded before a permission existed (or deactivated
 * by an older one-off migration, e.g. KAN-54 retiring INSPECTOR) must be
 * brought back in line with ROLE_PERMISSIONS.
 */
RoleSchema.statics.seedDefaultRoles = async function () {
  const { ROLE_PERMISSIONS } = await import('../constants/appConstants.js');
  const descriptions = {
    [Roles.ADMIN]:       'Full system access – can manage all resources and users.',
    [Roles.SALES_STAFF]: 'Operational access – inventory, customers, leads, appointments, and vehicle inspections.',
    [Roles.CUSTOMER]:    'Self-registered website customer – no internal permissions.',
    [Roles.INSPECTOR]:   'CPO vehicle inspector – performs inspection checklists; no sales access.', // KAN-94
  };

  // Idempotent: only inserts default roles that are missing, so databases seeded
  // before a role was introduced (e.g. CUSTOMER) receive it on next startup.
  const existing = await this.find({}, { name: 1, permissions: 1, isActive: 1 }).lean();
  const existingByName = new Map(existing.map((r) => [r.name, r]));

  const missing = Object.values(Roles)
    .filter((roleName) => !existingByName.has(roleName))
    .map((roleName) => ({
      name:        roleName,
      description: descriptions[roleName],
      permissions: ROLE_PERMISSIONS[roleName] || [],
    }));

  if (missing.length) {
    await this.insertMany(missing);
    console.log(`🌱  Roles seeded: ${missing.map((r) => r.name).join(', ')}`);
  }

  // Sync permissions + reactivate any default role that drifted (KAN-93/94)
  for (const roleName of Object.values(Roles)) {
    const current = existingByName.get(roleName);
    if (!current) continue; // just inserted above

    const expected = ROLE_PERMISSIONS[roleName] || [];
    const actual   = current.permissions || [];
    const samePerms = expected.length === actual.length && expected.every((p) => actual.includes(p));

    if (!samePerms || current.isActive === false) {
      await this.updateOne(
        { _id: current._id },
        { $set: { permissions: expected, isActive: true } }
      );
      console.log(
        `🌱  Role synced: ${roleName}` +
        (current.isActive === false ? ' (reactivated)' : '') +
        (samePerms ? '' : ` (${expected.length} permissions)`)
      );
    }
  }
};

const Role = mongoose.model('Role', RoleSchema);
export default Role;
