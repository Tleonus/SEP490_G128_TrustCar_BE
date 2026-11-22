/**
 * @file migrate-appointment-holds.js
 * @description One-off migration for the test-drive hold fields and the two unique indexes that
 * stop a double booking at the database level (appointmentHoldIndexes.js).
 *
 * Usage (npm run migrate:appointment-holds -- <flags>):
 *   (no flags) | --dry-run            read-only report; WRITES NOTHING (the default)
 *   --apply    --confirm-db=<name>    backfill holdsCar/visitSeat, then create the two indexes
 *   --rollback --confirm-db=<name>    drop the two indexes and remove holdsCar/visitSeat
 *   --batch-size=<1..1000>            rows per bulk write (default 200)
 *
 * Safety rules (REQ-221…223):
 *   - the target is MONGODB_URI; the connection string is never printed;
 *   - `--apply` / `--rollback` refuse to run unless `--confirm-db` equals the name of the database
 *     actually connected, so a wrong .env cannot be written to by accident;
 *   - `--apply` stops, creating nothing, when open rows already break the indexes (a car booked
 *     twice at one time, two visits on one seat): a human decides which booking stays;
 *   - only `$set holdsCar/visitSeat` on OPEN rows; nothing is deleted or overwritten; running it
 *     twice changes nothing; `--rollback` undoes it;
 *   - take a BACKUP first (mongodump / Atlas snapshot). This script does not.
 *
 * Exit codes: 0 done / report printed, 1 blocked or failed, 2 wrong usage (nothing was written).
 *
 * Ref: .sdd/features/test-drive-capacity-guard/SPEC.md (REQ-221…223), PLAN.md 3.5
 */

import mongoose from 'mongoose';
import { pathToFileURL } from 'url';
import { OPEN_STATUSES, DEFAULT_SLOT_CAPACITY } from '../src/constants/appointmentRules.js';
import { BASE_SETTINGS_KEY } from '../src/config/baseSettings.js';
import { ensureHoldIndexes, dropHoldIndexes } from '../src/models/appointmentHoldIndexes.js';
import {
  findDuplicates, planBackfill, buildReport, formatReport,
} from '../src/migrations/appointmentHolds.js';

const KNOWN_FLAGS = ['--dry-run', '--apply', '--rollback'];
const OPEN_FILTER = { status: { $in: [...OPEN_STATUSES] }, isActive: { $ne: false } };
const PROJECTION = {
  _id: 1, appointmentCode: 1, customer: 1, car: 1, scheduledAt: 1, status: 1, isActive: 1, type: 1, holdsCar: 1, visitSeat: 1, slotSeat: 1,
};

/**
 * @param {string[]} argv  Arguments after the script name.
 * @returns {{ mode: 'dry-run'|'apply'|'rollback', confirmDb: string|null, batchSize: number, errors: string[] }}
 */
export const parseArgs = (argv) => {
  const errors = [];
  let confirmDb = null;
  let batchSize = 200;
  const flags = [];
  argv.forEach((arg) => {
    if (arg.startsWith('--confirm-db=')) confirmDb = arg.slice('--confirm-db='.length);
    else if (arg.startsWith('--batch-size=')) batchSize = Number(arg.slice('--batch-size='.length));
    else if (KNOWN_FLAGS.includes(arg)) flags.push(arg);
    else errors.push(`Unknown argument: ${arg}`);
  });
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) errors.push('--batch-size must be an integer from 1 to 1000.');
  if (flags.includes('--apply') && flags.includes('--rollback')) errors.push('Choose one of --apply or --rollback, not both.');
  if (flags.includes('--dry-run') && (flags.includes('--apply') || flags.includes('--rollback'))) errors.push('--dry-run cannot be combined with --apply or --rollback.');
  let mode = 'dry-run';
  if (flags.includes('--apply')) mode = 'apply';
  if (flags.includes('--rollback')) mode = 'rollback';
  return { mode, confirmDb: confirmDb === '' ? null : confirmDb, batchSize, errors };
};

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

const loadOpenRows = (collection) => collection.find(OPEN_FILTER, { projection: PROJECTION }).toArray();

const analyse = async (collection, readCapacity) => {
  const rows = await loadOpenRows(collection);
  const { value, source } = await readCapacity();
  const capacity = Number.isInteger(value) && value >= 1 ? value : DEFAULT_SLOT_CAPACITY;
  const duplicates = findDuplicates(rows);
  const plan = planBackfill(rows, capacity);
  return { rows, capacity, duplicates, plan, source };
};

/**
 * Runs the migration against `collection`. Nothing here connects: the caller passes the collection.
 *
 * @param {object} p
 * @param {string[]} p.argv
 * @param {object} p.collection     MongoDB collection of the appointments (find, bulkWrite, updateMany, createIndex, dropIndex).
 * @param {string} p.dbName         Name of the database that collection belongs to.
 * @param {() => Promise<{ value: number|null, source: string }>} p.readCapacity
 * @param {(line: string) => void} [p.log]
 * @returns {Promise<{ exitCode: 0|1|2, report?: object }>}
 */
export const runMigration = async ({ argv, collection, dbName, readCapacity, log = console.log }) => {
  const { mode, confirmDb, batchSize, errors } = parseArgs(argv);
  if (errors.length > 0) {
    errors.forEach((line) => log(`ERROR ${line}`));
    return { exitCode: 2 };
  }
  log(`Target database: ${dbName}`);
  log(`Mode: ${mode.toUpperCase()}`);

  if (mode !== 'dry-run' && confirmDb !== dbName) {
    log(`ERROR --${mode} needs --confirm-db=${dbName} (the name of the database you are connected to). Nothing was written.`);
    return { exitCode: 2 };
  }

  if (mode === 'rollback') {
    log('Rolling back: dropping the two indexes, then removing holdsCar / visitSeat. (Back up first if you have not.)');
    const dropped = await dropHoldIndexes(collection);
    log(`Indexes dropped: ${dropped.length > 0 ? dropped.join(', ') : 'none (they did not exist)'}`);
    const result = await collection.updateMany(
      { $or: [{ holdsCar: { $exists: true } }, { visitSeat: { $exists: true } }] },
      { $unset: { holdsCar: 1, visitSeat: 1 } },
    );
    log(`Rows cleaned: ${result.modifiedCount}`);
    log('Rollback done.');
    return { exitCode: 0 };
  }

  const { rows, capacity, duplicates, plan, source } = await analyse(collection, readCapacity);
  const report = buildReport({ dbName, rows, capacity, capacitySource: source, duplicates, plan });
  formatReport(report).forEach(log);

  if (mode === 'dry-run') {
    log('Dry run only: nothing was written. Back up the database, then re-run with --apply --confirm-db=<name>.');
    return { exitCode: 0, report };
  }

  if (report.blocked) {
    log('Stopped: no data was written and no index was created.');
    return { exitCode: 1, report };
  }

  log('Applying: back up first if you have not. Writing holdsCar / visitSeat in batches...');
  let modified = 0;
  for (const batch of chunk(plan.updates, batchSize)) {
    // eslint-disable-next-line no-await-in-loop
    const result = await collection.bulkWrite(batch.map((update) => ({
      updateOne: { filter: { _id: update._id, ...OPEN_FILTER }, update: { $set: update.set } },
    })), { ordered: false });
    modified += result.modifiedCount ?? 0;
    log(`  batch of ${batch.length}: modified ${result.modifiedCount ?? 0}`);
  }
  log(`Rows updated: ${modified}`);

  // Rows may have been created or closed while the script ran: check again before the indexes.
  const check = await analyse(collection, readCapacity);
  if (check.duplicates.car.length > 0 || check.duplicates.seat.length > 0 || check.plan.updates.length > 0) {
    log(`Stopped: ${check.plan.updates.length} row(s) still need hold fields or duplicates appeared meanwhile. Run again; no index was created.`);
    return { exitCode: 1, report };
  }

  const names = await ensureHoldIndexes(collection);
  log(`Indexes created: ${names.join(', ')}`);
  log('Done. Deploy the new code now if you have not; every new booking holds its car and seat.');
  return { exitCode: 0, report };
};

const readCapacityFromSettings = (SystemSetting) => async () => {
  const record = await SystemSetting.findOne({ settingKey: BASE_SETTINGS_KEY, status: 'ACTIVE' }).lean();
  const stored = record?.value?.testDrive?.maxGuestsPerSlot;
  return Number.isInteger(stored)
    ? { value: stored, source: 'stored in the database' }
    : { value: null, source: `not stored; the code default ${DEFAULT_SLOT_CAPACITY} applies` };
};

const main = async () => {
  const argv = process.argv.slice(2);
  if (parseArgs(argv).errors.length > 0) {
    const { exitCode } = await runMigration({ argv, collection: null, dbName: '', readCapacity: async () => ({ value: null, source: '' }) });
    process.exit(exitCode);
  }
  await import('dotenv/config'); // only when run as a script, so importing this file (tests) never reads .env
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not defined. Check your .env file.');
    process.exit(2);
  }
  // autoIndex/autoCreate off: this connection must never build the schema's indexes on its own.
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  try {
    const { default: Appointment } = await import('../src/models/Appointment.js');
    const { default: SystemSetting } = await import('../src/models/system-setting.model.js');
    const { exitCode } = await runMigration({
      argv,
      collection: Appointment.collection,
      dbName: mongoose.connection.name,
      readCapacity: readCapacityFromSettings(SystemSetting),
    });
    process.exitCode = exitCode;
  } finally {
    await mongoose.disconnect();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Appointment hold migration failed:', error.message);
    process.exit(1);
  });
}
