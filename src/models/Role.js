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
 * Seeds the database with the two default roles if they don't already exist.
 * Called from server.js after DB connects.
 */
RoleSchema.statics.seedDefaultRoles = async function () {
  const { ROLE_PERMISSIONS } = await import('../constants/appConstants.js');
  const descriptions = {
    [Roles.ADMIN]:       'Full system access – can manage all resources and users.',
    [Roles.SALES_STAFF]: 'Operational access – inventory, customers, leads, and appointments.',
    [Roles.CUSTOMER]:    'Self-registered website customer – no internal permissions.',
  };

  // Idempotent: only inserts default roles that are missing, so databases seeded
  // before a role was introduced (e.g. CUSTOMER) receive it on next startup.
  const existing = await this.find({}, { name: 1 }).lean();
  const existingNames = new Set(existing.map((r) => r.name));
  const missing = Object.values(Roles)
    .filter((roleName) => !existingNames.has(roleName))
    .map((roleName) => ({
      name:        roleName,
      description: descriptions[roleName],
      permissions: ROLE_PERMISSIONS[roleName] || [],
    }));

  if (missing.length === 0) return;
  await this.insertMany(missing);
  console.log(`🌱  Roles seeded: ${missing.map((r) => r.name).join(', ')}`);
};

const Role = mongoose.model('Role', RoleSchema);
export default Role;
