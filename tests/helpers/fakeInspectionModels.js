/**
 * @file fakeInspectionModels.js
 * @description Test harness for inspection integration tests. Runs the REAL
 * Express app (routes → Joi → controllers → services → models) on top of the
 * auth harness, replacing only persistence for Car, InspectionRecord and
 * ActivityLog with in-memory Maps.
 *
 * Emulated database behaviour (keep in sync with what the inspection code uses):
 * - Transactions: `mongoose.startSession()` returns a fake session. Sessions are
 *   serialised (one transaction at a time, like a write lock); abort restores the
 *   snapshot taken at `startTransaction`, so a failed unit of work leaves no trace.
 * - Unique indexes: one DRAFT InspectionRecord per car (`uniq_draft_per_car`) and
 *   unique non-null `Car.cpoCertificateId`, both raising an E11000-like error.
 * - Queries: findById / findOne (Car, InspectionRecord; filters: equality, $in, $ne) / findOneAndUpdate (conditional, $set) with
 *   chainable .session() .select() .populate() .lean(); Model.create([docs], opts);
 *   doc.save(opts); ActivityLog.create([docs], opts).
 * - Fault injection: `failNextCarSaves(n, error)` makes the next n Car saves throw;
 *   `forceCpoCollisions(n)` makes the next n CPO-code checks (`Car.exists`) report a clash.
 *
 * Usage (top of a test file):
 *   import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';
 *   const h = await setupInspectionHarness();
 *   beforeEach(() => h.reset());
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAuthHarness } from './fakeAuthModels.js';

process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'trustcar-test';
process.env.CLOUDINARY_API_KEY    = process.env.CLOUDINARY_API_KEY || 'test-key';
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'test-secret';

const getPath = (obj, path) => path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);

const setPath = (obj, path, value) => {
  const keys = path.split('.');
  let cur = obj;
  keys.slice(0, -1).forEach((k) => {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  });
  cur[keys[keys.length - 1]] = value;
};

/** Deep clone that keeps ObjectId and Date instances. */
const clone = (v) => {
  if (v instanceof mongoose.Types.ObjectId) return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
};

const norm = (v) => (v instanceof mongoose.Types.ObjectId ? v.toString() : v instanceof Date ? v.getTime() : v);

const matches = (doc, filter = {}) => Object.entries(filter).every(([path, cond]) => {
  const actual = norm(getPath(doc, path));
  if (cond && typeof cond === 'object' && !(cond instanceof mongoose.Types.ObjectId) && '$in' in cond) {
    return cond.$in.map(norm).includes(actual);
  }
  if (cond && typeof cond === 'object' && !(cond instanceof mongoose.Types.ObjectId) && '$ne' in cond) {
    return actual !== norm(cond.$ne);
  }
  return actual === norm(cond);
});

const duplicateKeyError = (index, keyValue) => Object.assign(
  new Error(`E11000 duplicate key error index: ${index}`),
  { name: 'MongoServerError', code: 11000, keyPattern: Object.fromEntries(Object.keys(keyValue).map((k) => [k, 1])), keyValue },
);

/** Chainable, awaitable query over a resolver returning a raw stored object (or null). */
const fakeQuery = (Model, resolver) => {
  let lean = false;
  const q = {
    session: () => q, select: () => q, populate: () => q, sort: () => q,
    lean: () => { lean = true; return q; },
    exec: async () => {
      const raw = resolver();
      if (!raw) return null;
      return lean ? clone(raw) : Model.hydrate(clone(raw));
    },
    then: (ok, ko) => q.exec().then(ok, ko),
  };
  return q;
};

/**
 * Registers mocks over the auth harness and returns helpers for inspection tests.
 * Must be awaited at the top level of a test file before anything from src/.
 */
export const setupInspectionHarness = async () => {
  const auth = await setupAuthHarness();
  const { default: Car } = await import('../../src/models/Car.js');
  const { default: InspectionRecord } = await import('../../src/models/InspectionRecord.js');
  const { default: ActivityLog } = await import('../../src/models/ActivityLog.js');
  const { signAccessToken } = await import('../../src/utils/authTokens.js');

  const cars = new Map();
  const records = new Map();
  const activity = [];
  const faults = { carSaves: [], cpoCollisions: 0 };

  // ── Transactions: serialised fake sessions with snapshot/rollback ────────
  let lock = Promise.resolve();
  const snapshot = () => ({
    cars: new Map([...cars].map(([k, v]) => [k, clone(v)])),
    records: new Map([...records].map(([k, v]) => [k, clone(v)])),
    activity: activity.length,
  });
  const restore = (snap) => {
    cars.clear(); snap.cars.forEach((v, k) => cars.set(k, v));
    records.clear(); snap.records.forEach((v, k) => records.set(k, v));
    activity.length = snap.activity;
  };
  const sessionStats = { started: 0, committed: 0, aborted: 0 };

  jest.spyOn(mongoose, 'startSession').mockImplementation(async () => {
    let release;
    const previous = lock;
    lock = new Promise((resolve) => { release = resolve; });
    await previous;
    let snap = null;
    return {
      startTransaction() { snap = snapshot(); sessionStats.started += 1; },
      inTransaction() { return snap !== null; },
      async commitTransaction() { snap = null; sessionStats.committed += 1; },
      async abortTransaction() { if (snap) restore(snap); snap = null; sessionStats.aborted += 1; },
      async endSession() { release(); },
    };
  });

  // ── Car ───────────────────────────────────────────────────────────────────
  const assertCarUnique = (raw) => {
    if (!raw.cpoCertificateId) return;
    const clash = [...cars.values()].some((c) => String(c._id) !== String(raw._id) && c.cpoCertificateId === raw.cpoCertificateId);
    if (clash) throw duplicateKeyError('cpoCertificateId_1', { cpoCertificateId: raw.cpoCertificateId });
  };
  jest.spyOn(Car, 'findById').mockImplementation((id) => fakeQuery(Car, () => cars.get(String(id)) || null));
  jest.spyOn(Car, 'findOne').mockImplementation((filter) =>
    fakeQuery(Car, () => [...cars.values()].find((c) => matches(c, filter)) || null));
  jest.spyOn(Car, 'exists').mockImplementation((filter) => {
    const forced = filter.cpoCertificateId && faults.cpoCollisions > 0;
    if (forced) faults.cpoCollisions -= 1;
    const hit = forced || [...cars.values()].find((c) => matches(c, filter));
    return {
      session: () => Promise.resolve(hit ? { _id: hit._id || 'forced' } : null),
      then: (ok, ko) => Promise.resolve(hit ? { _id: hit._id || 'forced' } : null).then(ok, ko),
    };
  });
  jest.spyOn(Car.prototype, 'save').mockImplementation(async function save() {
    if (faults.carSaves.length) throw faults.carSaves.shift();
    await this.validate(this.modifiedPaths());
    const raw = this.toObject({ depopulate: true, virtuals: false });
    assertCarUnique(raw);
    cars.set(String(this._id), raw);
    this.isNew = false;
    return this;
  });

  // ── InspectionRecord ──────────────────────────────────────────────────────
  const recordList = (filter) => [...records.values()].filter((r) => matches(r, filter));
  const assertRecordUnique = (raw) => {
    if (raw.status !== 'DRAFT') return;
    const clash = [...records.values()].some((r) => String(r._id) !== String(raw._id)
      && r.status === 'DRAFT' && String(r.carId) === String(raw.carId));
    if (clash) throw duplicateKeyError('uniq_draft_per_car', { carId: raw.carId });
  };
  const storeRecord = async (doc) => {
    await doc.validate();
    const raw = doc.toObject({ depopulate: true, virtuals: false });
    assertRecordUnique(raw);
    records.set(String(doc._id), raw);
    return doc;
  };
  jest.spyOn(InspectionRecord, 'findById').mockImplementation((id) =>
    fakeQuery(InspectionRecord, () => records.get(String(id)) || null));
  jest.spyOn(InspectionRecord, 'findOne').mockImplementation((filter) =>
    fakeQuery(InspectionRecord, () => recordList(filter)[0] || null));
  jest.spyOn(InspectionRecord, 'create').mockImplementation(async (data) => {
    const list = Array.isArray(data) ? data : [data];
    const docs = [];
    for (const item of list) docs.push(await storeRecord(new InspectionRecord(item)));
    return Array.isArray(data) ? docs : docs[0];
  });
  // Synchronous match + write: atomic with respect to other requests (MongoDB
  // single-document atomicity), which is what the "only one submit wins" rule relies on.
  jest.spyOn(InspectionRecord, 'findOneAndUpdate').mockImplementation((filter, update, options = {}) => {
    const raw = recordList(filter)[0];
    let result = null;
    if (raw) {
      const before = clone(raw);
      const sets = update.$set || update;
      Object.entries(sets).forEach(([path, value]) => setPath(raw, path, clone(value)));
      const check = new InspectionRecord(raw).validateSync();
      if (check) {
        records.set(String(raw._id), before);
        return fakeQuery(InspectionRecord, () => { throw check; });
      }
      result = options.new ? raw : before;
    }
    return fakeQuery(InspectionRecord, () => result);
  });

  // ── ActivityLog (transactional create) ───────────────────────────────────
  jest.spyOn(ActivityLog, 'create').mockImplementation(async (data) => {
    const list = Array.isArray(data) ? data : [data];
    list.forEach((entry) => activity.push(clone(entry)));
    return list;
  });

  const harness = {
    ...auth,
    Car,
    InspectionRecord,
    cars,
    records,
    activity,
    sessionStats,

    reset() {
      auth.reset();
      cars.clear();
      records.clear();
      activity.length = 0;
      faults.carSaves.length = 0;
      faults.cpoCollisions = 0;
      Object.keys(sessionStats).forEach((k) => { sessionStats[k] = 0; });
    },

    /** Inserts a car straight into the store; returns its id. */
    createCar(overrides = {}) {
      const doc = new Car({
        make: 'Toyota', model: 'Vios', variant: '1.5G', year: 2020, mileage: 50000,
        specifications: { color: 'Trắng' }, status: 'INCOMING', ...overrides,
      });
      const raw = doc.toObject({ depopulate: true, virtuals: false });
      cars.set(String(doc._id), raw);
      return String(doc._id);
    },

    /** Inserts an inspection record straight into the store (no validation); returns its id. */
    insertRecord(data) {
      const doc = new InspectionRecord(data);
      records.set(String(doc._id), doc.toObject({ depopulate: true, virtuals: false }));
      return String(doc._id);
    },

    /** Creates a user with the given role and returns { id, token }. */
    async loginAs(roleName = 'SALES_STAFF') {
      const { id, email } = await auth.createUser({ roleName });
      const token = signAccessToken({ _id: id, email, roleName, tokenVersion: 0 });
      return { id, token, auth: `Bearer ${token}` };
    },

    /** Makes the next `count` Car saves throw `error` (default: a generic write failure). */
    failNextCarSaves(count = 1, error = null) {
      for (let i = 0; i < count; i += 1) faults.carSaves.push(error || new Error('Simulated write failure'));
    },

    /** Makes the next `count` CPO-code uniqueness checks report the code as taken. */
    forceCpoCollisions(count) { faults.cpoCollisions = count; },

    duplicateKeyError,
    car(id) { return cars.get(String(id)); },
    record(id) { return records.get(String(id)); },
  };

  return harness;
};

export default { setupInspectionHarness };
