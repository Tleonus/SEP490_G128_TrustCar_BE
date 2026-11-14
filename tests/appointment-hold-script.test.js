/**
 * @file appointment-hold-script.test.js
 * @description The migration script against a fake collection: it writes nothing unless told to,
 * refuses a wrong or missing --confirm-db, stops on duplicates, is idempotent, can be rolled back,
 * and nothing in the application creates the new indexes on its own.
 *
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-221
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-222
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#AC-30
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#AC-34
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#AC-35
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#AC-36
 */

import fs from 'node:fs';
import path from 'node:path';
import { matches } from './helpers/fakeAppointmentQuery.js';
import { runMigration, parseArgs } from '../scripts/migrate-appointment-holds.js';
import { default as Appointment } from '../src/models/Appointment.js';

const DB = 'trustcar_prod';
const T1 = new Date('2026-11-10T03:00:00Z');
const T2 = new Date('2026-11-10T06:00:00Z');
let n = 0;
const doc = (customer, car, scheduledAt, extra = {}) => ({
  _id: `id-${++n}`, appointmentCode: `APT-${String(1000 + n).padStart(4, '0')}`, customer, car, scheduledAt,
  status: 'PENDING', isActive: true, type: 'TEST_DRIVE', notes: 'keep me', ...extra,
});

/** A MongoDB-collection stand-in that records every call that could change data or indexes. */
const fakeCollection = (docs) => {
  const calls = { reads: 0, writes: [], order: [] };
  const indexes = new Set();
  return {
    docs,
    calls,
    indexes,
    find(filter) { calls.reads += 1; return { toArray: async () => docs.filter((d) => matches(d, filter)).map((d) => ({ ...d })) }; },
    async bulkWrite(ops) {
      calls.writes.push('bulkWrite'); calls.order.push('bulkWrite');
      let modified = 0;
      ops.forEach(({ updateOne: { filter, update } }) => {
        const hit = docs.find((d) => matches(d, filter));
        if (hit && !this.noop) { Object.assign(hit, update.$set); modified += 1; }
      });
      return { modifiedCount: modified };
    },
    async updateMany(filter, update) {
      calls.writes.push('updateMany'); calls.order.push('updateMany');
      let modified = 0;
      docs.filter((d) => ('holdsCar' in d) || ('visitSeat' in d)).forEach((d) => {
        Object.keys(update.$unset).forEach((k) => { delete d[k]; });
        modified += 1;
      });
      return { modifiedCount: modified };
    },
    async createIndex(key, options) { calls.writes.push('createIndex'); calls.order.push('createIndex'); indexes.add(options.name); },
    async dropIndex(name) {
      calls.writes.push('dropIndex'); calls.order.push('dropIndex');
      if (!indexes.has(name)) throw Object.assign(new Error('index not found'), { codeName: 'IndexNotFound' });
      indexes.delete(name);
    },
  };
};

const run = async (argv, collection, { capacity = { value: 3, source: 'stored in the database' } } = {}) => {
  const lines = [];
  const result = await runMigration({
    argv, collection, dbName: DB, readCapacity: async () => capacity, log: (line) => lines.push(line),
  });
  return { ...result, lines, text: lines.join('\n') };
};
const seed = () => [
  doc('anna', 'c1', T1), doc('anna', 'c2', T1), doc('ben', 'c3', T1, { slotSeat: 2, assignedTo: 'staff-1' }), doc('cara', 'c4', T2),
  doc('dan', 'c5', T2, { status: 'CANCELLED' }), // closed: never touched
  doc('eve', 'c6', T2, { isActive: false }), // hidden: never touched
];

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'dry-run', confirmDb: null, batchSize: 200, errors: [] });
    expect(parseArgs(['--dry-run']).mode).toBe('dry-run');
  });

  it('reads --apply / --rollback / --confirm-db / --batch-size', () => {
    expect(parseArgs(['--apply', '--confirm-db=x', '--batch-size=50'])).toMatchObject({ mode: 'apply', confirmDb: 'x', batchSize: 50, errors: [] });
    expect(parseArgs(['--rollback', '--confirm-db=x']).mode).toBe('rollback');
  });

  it.each([
    [['--aply'], /Unknown argument/],
    [['--apply', '--rollback'], /one of --apply or --rollback/],
    [['--dry-run', '--apply'], /cannot be combined/],
    [['--batch-size=0'], /batch-size/],
    [['--batch-size=abc'], /batch-size/],
    [['--batch-size=5000'], /batch-size/],
  ])('rejects %j', (argv, message) => {
    expect(parseArgs(argv).errors.join(' ')).toMatch(message);
  });

  it('an empty --confirm-db is the same as none', () => {
    expect(parseArgs(['--apply', '--confirm-db=']).confirmDb).toBeNull();
  });
});

describe('dry run (AC-30): writes nothing', () => {
  it.each([[[]], [['--dry-run']]])('%j reads, reports and changes nothing', async (argv) => {
    const collection = fakeCollection(seed());
    const before = JSON.stringify(collection.docs);
    const { exitCode, text } = await run(argv, collection);
    expect(exitCode).toBe(0);
    expect(collection.calls.writes).toEqual([]); // no bulkWrite / updateMany / createIndex / dropIndex
    expect(JSON.stringify(collection.docs)).toBe(before);
    expect(text).toMatch(/Database: trustcar_prod/);
    expect(text).toMatch(/Open appointment rows: 4 in 3 visit\(s\)/); // closed and hidden rows are not counted
    expect(text).toMatch(/maxGuestsPerSlot: 3 \(stored in the database\)/);
    expect(text).toMatch(/Rows that need hold fields: 4/);
    expect(text).toMatch(/Dry run only: nothing was written/);
  });

  it('needs no --confirm-db: it is read-only', async () => {
    expect((await run([], fakeCollection(seed()))).exitCode).toBe(0);
  });

  it('shows the database name, never a connection string', async () => {
    const { text } = await run([], fakeCollection(seed()));
    expect(text).not.toMatch(/mongodb(\+srv)?:\/\/|password/i);
  });

  it('with duplicates it still only reports (exit 0) and says it is blocked', async () => {
    const collection = fakeCollection([doc('anna', 'cx', T1), doc('ben', 'cx', T1)]);
    const { exitCode, text } = await run([], collection);
    expect(exitCode).toBe(0);
    expect(text).toMatch(/BLOCKING 1 car\(s\) booked twice/);
    expect(collection.calls.writes).toEqual([]);
  });
});

describe('--confirm-db (AC-35)', () => {
  it.each([
    ['--apply', []],
    ['--apply', ['--confirm-db=wrong_db']],
    ['--rollback', []],
    ['--rollback', ['--confirm-db=wrong_db']],
  ])('%s with %j is refused: exit 2, nothing written', async (flag, extra) => {
    const collection = fakeCollection(seed());
    const before = JSON.stringify(collection.docs);
    const { exitCode, text } = await run([flag, ...extra], collection);
    expect(exitCode).toBe(2);
    expect(collection.calls.writes).toEqual([]);
    expect(collection.calls.reads).toBe(0); // it does not even read
    expect(JSON.stringify(collection.docs)).toBe(before);
    expect(text).toMatch(/needs --confirm-db=trustcar_prod/);
  });

  it('bad arguments exit 2 before anything happens', async () => {
    const collection = fakeCollection(seed());
    const { exitCode } = await run(['--apply', '--confirm-db=trustcar_prod', '--nonsense'], collection);
    expect(exitCode).toBe(2);
    expect(collection.calls.writes).toEqual([]);
  });
});

describe('--apply', () => {
  it('backfills open rows, THEN creates the two indexes; only holdsCar/visitSeat change (AC-33)', async () => {
    const collection = fakeCollection(seed());
    const originals = JSON.parse(JSON.stringify(collection.docs));
    const { exitCode, text } = await run(['--apply', '--confirm-db=trustcar_prod'], collection);
    expect(exitCode).toBe(0);
    expect(collection.calls.order).toEqual(['bulkWrite', 'createIndex', 'createIndex']);
    expect([...collection.indexes].sort()).toEqual(['uniq_visit_car_time', 'uniq_visit_seat_time']);
    expect(text).toMatch(/Rows updated: 4/);
    expect(text).toMatch(/Indexes created: uniq_visit_car_time, uniq_visit_seat_time/);

    collection.docs.forEach((after, i) => {
      const before = originals[i];
      const { holdsCar, visitSeat, ...rest } = after;
      const { holdsCar: _h, visitSeat: _v, ...restBefore } = before;
      expect(JSON.parse(JSON.stringify(rest))).toEqual(restBefore); // every other field untouched (notes, slotSeat, assignedTo…)
      expect([holdsCar, visitSeat].every((v) => v === undefined || v === true || typeof v === 'number')).toBe(true);
    });
    const [a1, a2, ben, cara, closed, hidden] = collection.docs;
    expect(a1).toMatchObject({ holdsCar: true, visitSeat: 1 });
    expect(a2).toMatchObject({ holdsCar: true });
    expect(a2).not.toHaveProperty('visitSeat');
    expect(ben).toMatchObject({ holdsCar: true, visitSeat: 2, slotSeat: 2 }); // KAN-28 seat kept AND copied
    expect(cara).toMatchObject({ holdsCar: true, visitSeat: 1 });
    [closed, hidden].forEach((r) => { expect(r).not.toHaveProperty('holdsCar'); expect(r).not.toHaveProperty('visitSeat'); });
  });

  it('is idempotent (AC-32): a second --apply changes no row', async () => {
    const collection = fakeCollection(seed());
    await run(['--apply', '--confirm-db=trustcar_prod'], collection);
    const after = JSON.stringify(collection.docs);
    const again = await run(['--apply', '--confirm-db=trustcar_prod'], collection);
    expect(again.exitCode).toBe(0);
    expect(JSON.stringify(collection.docs)).toBe(after);
    expect(again.text).toMatch(/Rows that need hold fields: 0/);
    expect(again.text).toMatch(/Rows updated: 0/);
  });

  it('writes in batches of --batch-size', async () => {
    const collection = fakeCollection(seed());
    await run(['--apply', '--confirm-db=trustcar_prod', '--batch-size=1'], collection);
    expect(collection.calls.writes.filter((w) => w === 'bulkWrite')).toHaveLength(4);
  });

  it('STOPS on duplicates (AC-31): nothing written, no index, exit 1, the duplicates are listed', async () => {
    const dup = [doc('anna', 'cx', T1), doc('ben', 'cx', T1), doc('cara', 'cy', T2)];
    const collection = fakeCollection(dup);
    const before = JSON.stringify(collection.docs);
    const { exitCode, text } = await run(['--apply', '--confirm-db=trustcar_prod'], collection);
    expect(exitCode).toBe(1);
    expect(collection.calls.writes).toEqual([]);
    expect(JSON.stringify(collection.docs)).toBe(before);
    expect(text).toMatch(/BLOCKING 1 car\(s\) booked twice/);
    expect(text).toMatch(/Stopped: no data was written and no index was created/);
  });

  it('does not create the indexes when rows still need fields afterwards (changed while it ran)', async () => {
    const collection = fakeCollection(seed());
    collection.noop = true; // the bulk write changes nothing, as if rows were swapped underneath
    const { exitCode, text } = await run(['--apply', '--confirm-db=trustcar_prod'], collection);
    expect(exitCode).toBe(1);
    expect(collection.calls.writes).not.toContain('createIndex');
    expect(text).toMatch(/Run again; no index was created/);
  });

  it('an empty collection is fine: no write, the indexes are still created', async () => {
    const collection = fakeCollection([]);
    const { exitCode } = await run(['--apply', '--confirm-db=trustcar_prod'], collection);
    expect(exitCode).toBe(0);
    expect(collection.calls.writes).toEqual(['createIndex', 'createIndex']);
  });

  it('prints the stored capacity, or says the default applies when nothing is stored', async () => {
    const { text } = await run([], fakeCollection(seed()), { capacity: { value: null, source: 'not stored; the code default 3 applies' } });
    expect(text).toMatch(/maxGuestsPerSlot: 3 \(not stored; the code default 3 applies\)/);
  });
});

describe('--rollback (AC-34)', () => {
  it('drops both indexes and removes holdsCar/visitSeat; every other field is intact', async () => {
    const collection = fakeCollection(seed());
    const originals = JSON.parse(JSON.stringify(collection.docs));
    await run(['--apply', '--confirm-db=trustcar_prod'], collection);
    const { exitCode, text } = await run(['--rollback', '--confirm-db=trustcar_prod'], collection);
    expect(exitCode).toBe(0);
    expect(collection.indexes.size).toBe(0);
    expect(JSON.parse(JSON.stringify(collection.docs))).toEqual(originals); // back to exactly what it was
    expect(text).toMatch(/Indexes dropped: uniq_visit_car_time, uniq_visit_seat_time/);
    expect(text).toMatch(/Rollback done/);
  });

  it('on a database that was never migrated it changes nothing and does not fail', async () => {
    const collection = fakeCollection(seed());
    const before = JSON.stringify(collection.docs);
    const { exitCode, text } = await run(['--rollback', '--confirm-db=trustcar_prod'], collection);
    expect(exitCode).toBe(0);
    expect(JSON.stringify(collection.docs)).toBe(before);
    expect(text).toMatch(/none \(they did not exist\)/);
  });
});

describe('the application never builds the new indexes by itself (AC-36, REQ-221)', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
  const sources = walk(path.resolve('src')).filter((file) => file.endsWith('.js'));
  const read = (file) => fs.readFileSync(file, 'utf8');

  it('nothing in src imports or calls ensureHoldIndexes / dropHoldIndexes (only the migration script does)', () => {
    // Real uses only (an import of the module, or a call): comments that name the file do not count.
    const users = sources.filter((file) => /from '[^']*appointmentHoldIndexes[^']*'|ensureHoldIndexes\(|dropHoldIndexes\(/.test(read(file)))
      .map((file) => path.basename(file));
    expect(users).toEqual([]); // src only DEFINES them; scripts/migrate-appointment-holds.js is the one caller
  });

  it('nothing in src creates or syncs indexes on the appointment collection', () => {
    const offenders = sources.filter((file) => /syncIndexes|ensureIndexes|\.createIndex\(/.test(read(file)) && !/appointmentHoldIndexes/.test(file));
    expect(offenders.map((file) => path.basename(file))).toEqual([]);
  });

  it('the schema declares neither new index, nor any index on the new fields', () => {
    const declared = Appointment.schema.indexes();
    expect(declared.map(([, options]) => options?.name)).not.toEqual(expect.arrayContaining(['uniq_visit_car_time']));
    expect(declared.flatMap(([key]) => Object.keys(key))).not.toEqual(expect.arrayContaining(['holdsCar']));
    expect(declared.flatMap(([key]) => Object.keys(key))).not.toEqual(expect.arrayContaining(['visitSeat']));
  });

  it('the npm script exists', () => {
    const pkg = JSON.parse(read(path.resolve('package.json')));
    expect(pkg.scripts['migrate:appointment-holds']).toBe('node scripts/migrate-appointment-holds.js');
  });

  it('importing the script has no side effects: it does not connect or read the environment', () => {
    // runMigration is exported and the main block is guarded by the "run as a script" check
    const script = read(path.resolve('scripts/migrate-appointment-holds.js'));
    expect(script).toMatch(/import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
    expect(script).not.toMatch(/^import 'dotenv\/config'/m);
  });
});
