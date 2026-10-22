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
  const count = await this.countDocuments();
  if (count > 0) return;

  const defaults = Object.values(Roles).map((roleName) => ({
    name:        roleName,
    description: roleName === Roles.ADMIN
      ? 'Full system access – can manage all resources and users.'
      : 'Operational access – inventory, customers, leads, and appointments.',
    permissions: ROLE_PERMISSIONS[roleName] || [],
  }));

  await this.insertMany(defaults);
  console.log('🌱  Roles seeded: ADMIN, SALES_STAFF');
};

const Role = mongoose.model('Role', RoleSchema);
export default Role;
