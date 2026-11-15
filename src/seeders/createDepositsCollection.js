/**
 * @file createDepositsCollection.js
 * @description KAN-22 — creates the `deposits` collection with a JSON-schema validator and
 * every index the deposit flow relies on (incl. the unique "one active hold per car" index).
 *
 * Usage:
 *   node src/seeders/createDepositsCollection.js            -> dry run (read-only, prints the plan)
 *   node src/seeders/createDepositsCollection.js --apply    -> creates collection / validator / indexes
 *
 * Safety:
 *   - Dry run by default; nothing is written without --apply.
 *   - Idempotent: existing collection is kept (validator updated with collMod), existing
 *     indexes with the same name are skipped. No data is inserted, changed or deleted.
 *   - Aborts if existing data would violate the unique indexes.
 *
 * Ref: KAN-22
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { DEPOSIT_INDEXES } from '../models/Deposit.js';
import { DepositStatus, DepositPaymentStatus } from '../constants/depositConstants.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌  MONGODB_URI not set. Export it or add it to .env.');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const COLLECTION = 'deposits';

/** Server-side validator: guards the core invariants even for writes outside Mongoose. */
const validator = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['depositCode', 'carId', 'userId', 'customerId', 'depositAmount', 'status', 'paymentStatus',
      'holdActive', 'reservedAt', 'expiresAt', 'carStatusChangedAt'],
    properties: {
      depositCode:   { bsonType: 'string' },
      carId:         { bsonType: 'objectId' },
      userId:        { bsonType: 'objectId' },
      customerId:    { bsonType: 'objectId' },
      depositAmount: { bsonType: ['int', 'long', 'double', 'decimal'], minimum: 1 },
      status:        { enum: Object.values(DepositStatus) },
      paymentStatus: { enum: Object.values(DepositPaymentStatus) },
      holdActive:    { bsonType: 'bool' },
      reservedAt:    { bsonType: 'date' },
      expiresAt:     { bsonType: 'date' },
    },
  },
};

async function run() {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  console.log(`🔌  Connected to ${MONGODB_URI.replace(/\/\/.*@/, '//***@')} (db: ${db.databaseName})`);
  console.log(apply ? '⚡  MODE: APPLY (writes to DB)' : '🔍  MODE: DRY RUN (read-only)');

  const hello = await db.admin().command({ hello: 1 });
  const supportsTx = Boolean(hello.setName || hello.msg === 'isdbgrid');
  console.log(`ℹ️   Topology: ${hello.setName ? `replica set ${hello.setName}` : hello.msg === 'isdbgrid' ? 'sharded' : 'STANDALONE'}`
    + (supportsTx ? ' (transactions supported)' : ' (NO transactions – deposit module uses conditional updates + compensation)'));

  const exists = (await db.listCollections({ name: COLLECTION }).toArray()).length > 0;

  // 1) Collection + validator
  if (!exists) {
    console.log(`\n📦  Collection "${COLLECTION}" does not exist → will be created with validator.`);
    if (apply) await db.createCollection(COLLECTION, { validator, validationLevel: 'moderate', validationAction: 'error' });
  } else {
    console.log(`\n📦  Collection "${COLLECTION}" exists → validator will be (re)applied with collMod.`);
    if (apply) await db.command({ collMod: COLLECTION, validator, validationLevel: 'moderate', validationAction: 'error' });

    // Pre-check data that would break the unique indexes.
    const dupHolds = await db.collection(COLLECTION).aggregate([
      { $match: { holdActive: true } },
      { $group: { _id: '$carId', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]).toArray();
    if (dupHolds.length) {
      console.error('❌  Several active holds exist for the same car – fix the data before creating the index:', dupHolds);
      process.exit(1);
    }
  }

  // 2) Indexes
  const existing = exists || apply
    ? (await db.collection(COLLECTION).indexes().catch(() => [])).map((i) => i.name)
    : [];
  console.log('\n🗂️   Indexes:');
  for (const [keys, options] of DEPOSIT_INDEXES) {
    if (existing.includes(options.name)) {
      console.log(`   = ${options.name} (already present)`);
      continue;
    }
    console.log(`   + ${options.name} ${JSON.stringify(keys)} ${JSON.stringify({ ...options, name: undefined })}`);
    if (apply) await db.collection(COLLECTION).createIndex(keys, options);
  }

  console.log(apply ? '\n✅  Done.' : '\nℹ️   Dry run only. Re-run with --apply to create the collection and indexes.');
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error('❌  Failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
