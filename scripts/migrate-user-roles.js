/**
 * @file migrate-user-roles.js
 * @description KAN-93 one-off migration: copy the legacy single role fields
 * (`role` / `roleName`) into the new multi-role arrays (`roles` / `roleNames`).
 *
 * Idempotent — users that already have a non-empty `roles` array are skipped,
 * so the script can be re-run safely.
 *
 * Usage:
 *   node -r dotenv/config scripts/migrate-user-roles.js
 */

import mongoose from 'mongoose';
import User from '../src/models/User.js';

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI (or MONGO_URI) is not set.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected. Starting KAN-93 role migration…');

  const cursor = User.find({
    role: { $ne: null },
    $or: [{ roles: { $exists: false } }, { roles: { $size: 0 } }],
  })
    .select('role roleName roles roleNames')
    .cursor();

  let updated = 0;
  let skipped = 0;

  for await (const user of cursor) {
    if (Array.isArray(user.roles) && user.roles.length > 0) {
      skipped++;
      continue;
    }

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          roles:     [user.role],
          roleNames: user.roleName ? [user.roleName] : [],
        },
      },
      { runValidators: false }
    );
    updated++;
  }

  console.log(`Migration complete. Updated: ${updated}, skipped: ${skipped}.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
