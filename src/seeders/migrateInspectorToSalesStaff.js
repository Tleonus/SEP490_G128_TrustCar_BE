/**
 * @file migrateInspectorToSalesStaff.js
 * @description KAN-54 — One-time migration: converts every INSPECTOR user to SALES_STAFF.
 *
 * What it does:
 *   1. Finds the SALES_STAFF role document (must already exist in `roles` collection).
 *   2. Updates all users where roleName = 'INSPECTOR':
 *      - Sets roleName → 'SALES_STAFF'
 *      - Sets role     → SALES_STAFF role ObjectId
 *   3. Optionally deactivates the INSPECTOR role document so it can no longer be assigned.
 *
 * Usage:
 *   node src/seeders/migrateInspectorToSalesStaff.js                 -> dry run (read-only)
 *   node src/seeders/migrateInspectorToSalesStaff.js --apply         -> writes to DB
 *
 * Safety:
 *   - Dry run by default: shows what *would* change without touching data.
 *   - Idempotent: running it again after migration finds 0 INSPECTOR users.
 *   - Does NOT drop the INSPECTOR role document — only sets isActive = false.
 *
 * Ref: KAN-54
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌  MONGODB_URI not set. Export it or add it to .env.');
  process.exit(1);
}

const apply = process.argv.includes('--apply');

async function migrate() {
  await mongoose.connect(MONGODB_URI);
  console.log(`🔌  Connected to ${MONGODB_URI.replace(/\/\/.*@/, '//***@')}`);
  console.log(apply ? '⚡  MODE: APPLY (writes to DB)' : '🔍  MODE: DRY RUN (read-only)');

  const db = mongoose.connection.db;
  const usersCol = db.collection('users');
  const rolesCol = db.collection('roles');

  // ── Step 1: resolve SALES_STAFF role ────────────────────────────────────────
  const salesStaffRole = await rolesCol.findOne({ name: 'SALES_STAFF', isActive: true });
  if (!salesStaffRole) {
    console.error('❌  SALES_STAFF role not found or inactive. Seed roles first.');
    process.exit(1);
  }
  console.log(`✅  SALES_STAFF role _id: ${salesStaffRole._id}`);

  // ── Step 2: find INSPECTOR users ────────────────────────────────────────────
  const inspectorUsers = await usersCol.find({ roleName: 'INSPECTOR' }).toArray();
  console.log(`\n📋  INSPECTOR users found: ${inspectorUsers.length}`);
  for (const u of inspectorUsers) {
    console.log(`   • ${u.email} (${u.fullName || '—'}) — _id: ${u._id}`);
  }

  if (inspectorUsers.length === 0) {
    console.log('\n✅  Nothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  // ── Step 3: migrate ─────────────────────────────────────────────────────────
  if (!apply) {
    console.log('\n🔍  Dry run — no changes written. Re-run with --apply to execute.');
    await mongoose.disconnect();
    return;
  }

  const result = await usersCol.updateMany(
    { roleName: 'INSPECTOR' },
    { $set: { roleName: 'SALES_STAFF', role: salesStaffRole._id } },
  );
  console.log(`\n✅  Users updated: ${result.modifiedCount}`);

  // ── Step 4: deactivate INSPECTOR role document ──────────────────────────────
  const roleResult = await rolesCol.updateOne(
    { name: 'INSPECTOR' },
    { $set: { isActive: false } },
  );
  if (roleResult.modifiedCount) {
    console.log('✅  INSPECTOR role document set to isActive: false.');
  } else {
    console.log('ℹ️   INSPECTOR role document not found or already inactive.');
  }

  console.log('\n🎉  Migration complete.');
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('❌  Migration failed:', err);
  process.exit(1);
});
