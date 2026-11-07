/**
 * @file fakeTestDriveModels.js
 * @description Test harness for test-drive booking. Runs real services and models
 * on top of the auth harness, replacing only persistence for Appointment, Car,
 * ActivityLog and SystemSetting with in-memory stores. Never connects to MongoDB.
 *
 * Emulated database behaviour (keep in sync with what the test-drive code uses):
 * - Transactions: sessions are serialised; abort restores the snapshot.
 * - The unique indexes declared on Appointment, including their partial filter.
 * - Conditional findOneAndUpdate with $set/$unset, atomic per document.
 * - Filters: equality (null also matches a missing field), $in, $ne, $gt, $gte, $lt, $lte, $regex.
 * It does NOT prove how real MongoDB behaves under concurrency: requests run one
 * at a time here, so a lost race is simulated with `beforeNextCreate`.
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAuthHarness } from './fakeAuthModels.js';

const getPath = (obj, path) => path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
const norm = (v) => (v instanceof mongoose.Types.ObjectId ? v.toString() : v instanceof Date ? v.getTime() : v);
const clone = (v) => {
  if (v instanceof mongoose.Types.ObjectId) return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
};

const OPERATORS = {
  $in: (actual, list) => list.map(norm).includes(actual ?? null),
  $ne: (actual, value) => (actual ?? null) !== norm(value),
  $gt: (actual, value) => actual != null && actual > norm(value),
  $gte: (actual, value) => actual != null && actual >= norm(value),
  $lt: (actual, value) => actual != null && actual < norm(value),
  $lte: (actual, value) => actual != null && actual <= norm(value),
  $regex: (actual, value) => typeof actual === 'string' && new RegExp(value).test(actual),
};

const isOperatorObject = (cond) => cond && typeof cond === 'object'
  && !(cond instanceof mongoose.Types.ObjectId) && !(cond instanceof Date);

const matches = (doc, filter = {}) => Object.entries(filter).every(([path, cond]) => {
  const actual = norm(getPath(doc, path));
  if (isOperatorObject(cond)) return Object.entries(cond).every(([op, value]) => OPERATORS[op](actual, value));
  return (actual ?? null) === (norm(cond) ?? null);
});

const duplicateKey = (index) => Object.assign(new Error(`E11000 duplicate key error index: ${index}`), {
  name: 'MongoServerError', code: 11000,
});

/** Chainable, awaitable query over a resolver returning stored documents. */
const listQuery = (resolve, populators = {}, { single = false } = {}) => {
  let sortSpec = null;
  let skipCount = 0;
  let limitCount = null;
  const paths = [];
  const q = {
    session: () => q, select: () => q, lean: () => q,
    sort: (spec) => { sortSpec = spec; return q; },
    skip: (n) => { skipCount = n; return q; },
    limit: (n) => { limitCount = n; return q; },
    populate: (path) => { paths.push(path); return q; },
    then: (ok, ko) => Promise.resolve().then(() => {
      let rows = resolve().map(clone);
      if (sortSpec) {
        const [[field, direction]] = Object.entries(sortSpec);
        rows.sort((a, b) => (norm(a[field]) > norm(b[field]) ? direction : -direction));
      }
      rows = rows.slice(skipCount, limitCount == null ? undefined : skipCount + limitCount);
      rows.forEach((row) => paths.forEach((path) => {
        if (populators[path] && row[path]) row[path] = clone(populators[path](row[path])) ?? null;
      }));
      return single ? rows[0] ?? null : rows;
    }).then(ok, ko),
  };
  return q;
};

/** Must be awaited at the top level of a test file before anything from src/. */
export const setupTestDriveHarness = async () => {
  const auth = await setupAuthHarness();
  const { default: Appointment } = await import('../../src/models/Appointment.js');
  const { default: Car } = await import('../../src/models/Car.js');
  const { default: ActivityLog } = await import('../../src/models/ActivityLog.js');
  const { default: SystemSetting } = await import('../../src/models/system-setting.model.js');
  const { signAccessToken } = await import('../../src/utils/authTokens.js');

  const appointments = new Map();
  const cars = new Map();
  const activity = [];
  const state = { settings: null, createFaults: [], beforeCreate: [], snapshot: null, stats: { committed: 0, aborted: 0 } };

  const populators = {
    car: (id) => cars.get(String(id)),
    customer: (id) => auth.customers.get(String(id)),
    assignedTo: (id) => auth.users.get(String(id)),
  };

  // ── Transactions ───────────────────────────────────────────────────────
  let lock = Promise.resolve();
  jest.spyOn(mongoose, 'startSession').mockImplementation(async () => {
    let release;
    const previous = lock;
    lock = new Promise((resolve) => { release = resolve; });
    await previous;
    return {
      startTransaction() {
        state.snapshot = { rows: new Map([...appointments].map(([k, v]) => [k, clone(v)])), activity: activity.length };
      },
      inTransaction() { return state.snapshot !== null; },
      async commitTransaction() { state.snapshot = null; state.stats.committed += 1; },
      async abortTransaction() {
        if (state.snapshot) {
          appointments.clear();
          state.snapshot.rows.forEach((v, k) => appointments.set(k, v));
          activity.length = state.snapshot.activity;
        }
        state.snapshot = null;
        state.stats.aborted += 1;
      },
      async endSession() { release(); },
    };
  });

  // ── Appointment ────────────────────────────────────────────────────────
  const assertUnique = (raw) => {
    const others = [...appointments.values()].filter((a) => String(a._id) !== String(raw._id));
    if (raw.appointmentCode && others.some((a) => a.appointmentCode === raw.appointmentCode)) throw duplicateKey('appointmentCode_1');
    if (typeof raw.slotSeat !== 'number') return;
    const sameTime = others.filter((a) => typeof a.slotSeat === 'number' && norm(a.scheduledAt) === norm(raw.scheduledAt));
    if (sameTime.some((a) => norm(a.car) === norm(raw.car))) throw duplicateKey('uniq_seat_car_time');
    if (raw.assignedTo && sameTime.some((a) => norm(a.assignedTo) === norm(raw.assignedTo))) throw duplicateKey('uniq_seat_staff_time');
    if (sameTime.some((a) => a.slotSeat === raw.slotSeat)) throw duplicateKey('uniq_seat_number_time');
  };

  const rows = (filter) => [...appointments.values()].filter((a) => matches(a, filter));

  jest.spyOn(Appointment, 'find').mockImplementation((filter) => listQuery(() => rows(filter), populators));
  jest.spyOn(Appointment, 'findById').mockImplementation((id) =>
    listQuery(() => rows({ _id: id }), populators, { single: true }));
  jest.spyOn(Appointment, 'findOne').mockImplementation((filter, _projection, options = {}) => {
    const q = listQuery(() => rows(filter), populators, { single: true });
    return options.sort ? q.sort(options.sort) : q;
  });
  jest.spyOn(Appointment, 'countDocuments').mockImplementation((filter) => {
    const q = { session: () => q, then: (ok, ko) => Promise.resolve(rows(filter).length).then(ok, ko) };
    return q;
  });
  jest.spyOn(Appointment, 'distinct').mockImplementation((field, filter) => {
    const q = {
      session: () => q,
      then: (ok, ko) => Promise.resolve([...new Map(rows(filter).map((a) => [norm(a[field]), a[field]])).values()]).then(ok, ko),
    };
    return q;
  });
  jest.spyOn(Appointment, 'create').mockImplementation(async (data) => {
    const stored = [];
    for (const item of data) {
      if (state.beforeCreate.length) state.beforeCreate.shift()();
      if (state.createFaults.length) throw state.createFaults.shift();
      const doc = new Appointment(item);
      await doc.validate();
      const raw = { ...doc.toObject({ depopulate: true, virtuals: false }), createdAt: new Date(), updatedAt: new Date() };
      assertUnique(raw);
      appointments.set(String(raw._id), raw);
      stored.push(doc);
    }
    return stored;
  });
  // Synchronous match + write: atomic per document, like MongoDB.
  jest.spyOn(Appointment, 'findOneAndUpdate').mockImplementation((filter, update, options = {}) => {
    const raw = rows(filter)[0];
    let error = null;
    let result = [];
    if (raw) {
      const next = clone(raw);
      Object.entries(update.$set || {}).forEach(([path, value]) => { next[path] = clone(value); });
      Object.keys(update.$unset || {}).forEach((path) => { delete next[path]; });
      next.updatedAt = new Date();
      try {
        assertUnique(next);
        appointments.set(String(raw._id), next);
        result = [options.new ? next : raw];
      } catch (uniqueError) {
        error = uniqueError;
      }
    }
    return listQuery(() => { if (error) throw error; return result; }, populators, { single: true });
  });

  // ── Supporting models ──────────────────────────────────────────────────
  jest.spyOn(Car, 'findById').mockImplementation((id) =>
    listQuery(() => (cars.get(String(id)) ? [cars.get(String(id))] : []), {}, { single: true }));
  jest.spyOn(Car, 'find').mockImplementation((filter) => listQuery(() => [...cars.values()].filter((c) => matches(c, filter))));
  jest.spyOn(auth.User, 'find').mockImplementation((filter) => listQuery(() => [...auth.users.values()].filter((u) => matches(u, filter))));
  jest.spyOn(ActivityLog, 'create').mockImplementation(async (entries) => {
    entries.forEach((entry) => activity.push(clone(entry)));
    return entries;
  });
  jest.spyOn(SystemSetting, 'findOne').mockImplementation(() => ({ lean: async () => (state.settings ? { value: clone(state.settings) } : null) }));

  return {
    ...auth,
    Appointment,
    appointments,
    cars,
    activity,
    stats: state.stats,

    reset() {
      auth.reset();
      appointments.clear();
      cars.clear();
      activity.length = 0;
      state.settings = null;
      state.createFaults.length = 0;
      state.beforeCreate.length = 0;
      state.snapshot = null;
      state.stats.committed = 0;
      state.stats.aborted = 0;
    },

    /** Stored showroom settings; null means the defaults are used. */
    useSettings(value) { state.settings = value; },

    createCar(overrides = {}) {
      const doc = new Car({
        make: 'Toyota', model: 'Vios', variant: '1.5G', year: 2020, mileage: 50000,
        specifications: { color: 'Trắng' }, status: 'AVAILABLE', ...overrides,
      });
      cars.set(String(doc._id), doc.toObject({ depopulate: true, virtuals: false }));
      return String(doc._id);
    },

    /** Creates an account and returns { id, token, auth } for API calls. */
    async loginAs(roleName = 'SALES_STAFF', overrides = {}) {
      const { id, email } = await auth.createUser({ roleName, ...overrides });
      const token = signAccessToken({ _id: id, email, roleName, tokenVersion: 0 });
      return { id, token, auth: `Bearer ${token}` };
    },

    /** Inserts an appointment straight into the store, checking the unique indexes. */
    insertAppointment(data) {
      const doc = new Appointment({ type: 'TEST_DRIVE', createdBy: new mongoose.Types.ObjectId(), ...data });
      const raw = { ...doc.toObject({ depopulate: true, virtuals: false }), createdAt: data.createdAt || new Date(), updatedAt: new Date() };
      assertUnique(raw);
      appointments.set(String(raw._id), raw);
      if (state.snapshot) state.snapshot.rows.set(String(raw._id), clone(raw));
      return String(raw._id);
    },

    /** Runs `fn` just before the next Appointment.create: a competitor winning the race. */
    beforeNextCreate(fn) { state.beforeCreate.push(fn); },

    /** Makes the next Appointment.create calls throw. */
    failNextCreates(...errors) { state.createFaults.push(...errors); },

    /** A write conflict as MongoDB labels it. */
    writeConflict() {
      return Object.assign(new Error('Write conflict (simulated)'), {
        name: 'MongoServerError', code: 112, errorLabels: ['TransientTransactionError'],
        hasErrorLabel(label) { return label === 'TransientTransactionError'; },
      });
    },

    appointment(id) { return appointments.get(String(id)); },
  };
};

export default { setupTestDriveHarness };
