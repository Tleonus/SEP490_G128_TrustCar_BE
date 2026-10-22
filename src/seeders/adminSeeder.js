/**
 * @file adminSeeder.js
 * @description Seeds the initial Admin account on first startup if no admin exists.
 *
 * Reads credentials from environment variables:
 *   ADMIN_EMAIL    (default: admin@trustcar.vn)
 *   ADMIN_PASSWORD (default: Admin@2024!)
 *   ADMIN_NAME     (default: System Admin)
 *
 * This seeder is idempotent – calling it multiple times is safe.
 * Once an admin account exists in the database, subsequent calls are no-ops.
 *
 * Ref: GBR-03 (Admin account provisioning)
 */

import User from '../models/User.js';
import Role from '../models/Role.js';
import { Roles } from '../constants/appConstants.js';

/**
 * Seeds the first Admin account if no admin user exists in the database.
 * Called from server.js after Role seeding.
 *
 * @returns {Promise<void>}
 */
export const seedAdminAccount = async () => {
  try {
    // Check if any admin account already exists
    const existingAdmin = await User.findOne({ roleName: Roles.ADMIN, isActive: true });
    if (existingAdmin) {
      console.log('📋  Admin seeder: Admin account already exists. Skipping.');
      return;
    }

    // Resolve the ADMIN role document
    const adminRole = await Role.findOne({ name: Roles.ADMIN, isActive: true });
    if (!adminRole) {
      console.error('❌  Admin seeder: ADMIN role not found. Run Role.seedDefaultRoles() first.');
      return;
    }

    // Read credentials from environment
    const email    = process.env.ADMIN_EMAIL    || 'admin@trustcar.vn';
    const password = process.env.ADMIN_PASSWORD || 'Admin@2024!';
    const fullName = process.env.ADMIN_NAME     || 'System Admin';

    // Create the admin account
    await User.create({
      fullName,
      email:    email.toLowerCase(),
      password, // Pre-save hook will hash this
      role:     adminRole._id,
      roleName: Roles.ADMIN,
      isActive: true,
    });

    console.log('🌱  Admin seeder: Default admin account created.');
    console.log(`    Email:    ${email}`);
    console.log(`    Password: (set via ADMIN_PASSWORD env var)`);
    console.log('    ⚠️  Change the default password immediately in production!');

  } catch (error) {
    // Non-fatal: log and continue – app should still start
    if (error.code === 11000) {
      // Duplicate key – admin already exists (race condition edge case)
      console.log('📋  Admin seeder: Admin account already exists (duplicate key). Skipping.');
      return;
    }
    console.error('⚠️  Admin seeder failed (non-fatal):', error.message);
  }
};

export default { seedAdminAccount };
