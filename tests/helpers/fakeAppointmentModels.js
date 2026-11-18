/**
 * @file fakeAppointmentModels.js
 * @description In-memory stand-ins for the models used by the test-drive booking
 * services (no MongoDB): Appointment (find/findOne/create/updateOne/updateMany/findOneAndUpdate),
 * Car (find), Customer (find/findOne/updateOne), User (find), plus `mongoose.startSession` and
 * the showroom settings. The real Appointment schema validates every stored row.
 *
 * Features beyond plain storage:
 * - `calls`: every query as `{ model, method, filter }` (assert query counts, NFR-01…03).
 * - `hook`: optional async function awaited before/after each Appointment call;
 *   tests use it to run a competing request at an exact moment (race tests).
 * - duplicate `appointmentCode` throws a Mongo-style E11000 error.
 *
 * Transactions (`withTransaction` works against this fake):
 * - a write made with `{ session }` while the session is in a transaction is journalled, and
 *   `abortTransaction` undoes it (rollback); writes of other sessions/requests stay untouched;
 * - two active transactions writing the same document: the second throws a
 *   `TransientTransactionError` (what MongoDB does on a write conflict);
 * - reads are NOT isolated (they see other transactions' uncommitted rows). The services re-read
 *   inside the transaction and rely on the locks and indexes above, which is what is under test.
 *
 * Partial unique indexes (off by default so older tests keep their behaviour):
 *   `fakes.enableIndexes('car')`, `('seat')` or both. On a clash the write throws E11000 with the
 *   `keyPattern` MongoDB reports (`{ car, scheduledAt }` / `{ scheduledAt, visitSeat }`).
 *   `appointmentCode` is unique too (always on, like the real index); `fakes.allowDuplicateCodes()`
 *   switches that one off so a test can prove the car/seat indexes on their own: two concurrent
 *   requests usually read the same "next code" and would otherwise collide on it first.
 *
 * Settings: `fakes.capacity = n` sets `testDrive.maxGuestsPerSlot` (default 2, the old fixed value,
 * so existing tests keep their numbers).
 *
 * Supported filters: equality, $in, $gt, $gte, $lt, $lte, $ne, $nin, $exists, $type, $regex
 * (+$options), $or (ObjectId/Date aware). Supported updates: $set, $unset.
 * Query chain: select (top-level names), sort, skip, limit, lean, populate/session (ignored).
 *
 * Usage: import AFTER setupAuthHarness() when the HTTP app is involved.
 *   const fakes = await setupAppointmentFakes();   beforeEach(() => fakes.reset());
 */

import mongoose from 'mongoose';
import { FakeQuery, matches, clone } from './fakeAppointmentQuery.js';

const { ObjectId } = mongoose.Types;

const SAME_TIME = (a, b) => new Date(a.scheduledAt).getTime() === new Date(b.scheduledAt).getTime();

/** The two hold indexes, as the database would apply them. */
const INDEX_RULES = {
  car: {
    name: 'uniq_visit_car_time',
    keyPattern: { car: 1, scheduledAt: 1 },
    applies: (row) => row.holdsCar === true,
    clash: (a, b) => String(a.car) === String(b.car) && SAME_TIME(a, b),
  },
  seat: {
    name: 'uniq_visit_seat_time',
    keyPattern: { scheduledAt: 1, visitSeat: 1 },
    applies: (row) => typeof row.visitSeat === 'number',
    clash: (a, b) => a.visitSeat === b.visitSeat && SAME_TIME(a, b),
  },
};

const transientConflict = () => Object.assign(new Error('WriteConflict (simulated)'), {
  code: 112, codeName: 'WriteConflict', hasErrorLabel: (label) => label === 'TransientTransactionError',
});

const duplicateKey = (name, keyPattern) =>
  Object.assign(new Error(`E11000 duplicate key error index: ${name}`), { code: 11000, keyPattern });

/** Replaces every field of `target` with those of `snapshot` (undo of an update). */
const restore = (target, snapshot) => {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, clone(snapshot));
};

/** Installs the fakes on the real model classes. */
export const setupAppointmentFakes = async () => {
  const { jest } = await import('@jest/globals');
  const { default: Appointment } = await import('../../src/models/Appointment.js');
  const { default: Car } = await import('../../src/models/Car.js');
  const { default: Customer } = await import('../../src/models/Customer.js');
  const { default: User } = await import('../../src/models/User.js');
  const { default: SystemSetting } = await import('../../src/models/system-setting.model.js');
  const { getDefaultBaseSettings } = await import('../../src/config/baseSettings.js');

  const state = {
    appointments: [], cars: [], customers: [], users: [], calls: [], hook: null, now: () => new Date(),
    capacity: 2, indexes: new Set(), locks: new Map(), sessions: [], codeUnique: true,
  };

  // E-mail: every test that uses these fakes gets a recording sender, so the real provider
  // can never be reached. `mail.fail` / `mail.delayMs` simulate a broken or slow provider.
  const mailService = await import('../../src/services/appointmentMailService.js');
  const mail = { sent: [], fail: false, delayMs: 0 };
  mailService.setMailSender(async (message) => {
    if (mail.delayMs) await new Promise((resolve) => { setTimeout(resolve, mail.delayMs); });
    if (mail.fail) throw new Error('SMTP unavailable (simulated)');
    mail.sent.push(message);
  });

  const record = async (model, method, filter, phase = 'before') => {
    if (phase === 'before') state.calls.push({ model, method, filter });
    if (state.hook) await state.hook({ model, method, filter, phase });
  };
  // `findOne(filter, projection, { sort })` is the 3-argument form used by generateAppointmentCode.
  const findQuery = (model, list, method, single) => (filter = {}, _projection, options) => {
    const query = new FakeQuery(async () => {
      await record(model, method, filter);
      const found = state[list].filter((doc) => matches(doc, filter));
      await record(model, method, filter, 'after');
      return found;
    }, single);
    return options?.sort ? query.sort(options.sort) : query;
  };

  // ── Transactions ─────────────────────────────────────────────────────────
  const releaseLocks = (session) => {
    [...state.locks].forEach(([key, owner]) => { if (owner === session) state.locks.delete(key); });
  };

  const makeSession = () => {
    const session = {
      active: false,
      journal: [],
      startTransaction() { session.active = true; session.journal = []; },
      inTransaction: () => session.active,
      async commitTransaction() { session.active = false; session.journal = []; releaseLocks(session); },
      async abortTransaction() {
        session.journal.reverse().forEach((undo) => undo());
        session.journal = [];
        session.active = false;
        releaseLocks(session);
      },
      async endSession() { session.active = false; releaseLocks(session); },
    };
    state.sessions.push(session);
    return session;
  };
  jest.spyOn(mongoose, 'startSession').mockImplementation(async () => makeSession());

  /** Journals a change made inside a transaction and takes the write lock of its document. */
  const track = (session, key, undo) => {
    if (!session?.inTransaction?.()) return;
    const owner = state.locks.get(key);
    if (owner && owner !== session && owner.active) throw transientConflict();
    state.locks.set(key, session);
    session.journal.push(undo);
  };

  /** Throws E11000 when `row` breaks an enabled hold index against another row. */
  const assertUnique = (row) => {
    Object.entries(INDEX_RULES).forEach(([flag, rule]) => {
      if (!state.indexes.has(flag) || !rule.applies(row)) return;
      const other = state.appointments.find((x) => x !== row && rule.applies(x) && rule.clash(row, x));
      if (other) throw duplicateKey(rule.name, rule.keyPattern);
    });
  };

  /** Applies `$set` / `$unset` to a stored document, journalling it and checking the indexes. */
  const applyUpdate = (doc, update, session, key) => {
    const before = clone(doc);
    track(session, key, () => restore(doc, before));
    Object.assign(doc, update.$set ?? {}, { updatedAt: state.now() });
    Object.keys(update.$unset ?? {}).forEach((field) => { delete doc[field]; });
    if (key.startsWith('Appointment:')) {
      try { assertUnique(doc); } catch (error) { restore(doc, before); throw error; }
    }
    return before;
  };

  const keyOf = (model, doc) => `${model}:${doc._id}`;

  // ── Query methods ────────────────────────────────────────────────────────
  jest.spyOn(Appointment, 'find').mockImplementation(findQuery('Appointment', 'appointments', 'find', false));
  jest.spyOn(Appointment, 'findOne').mockImplementation(findQuery('Appointment', 'appointments', 'findOne', true));
  jest.spyOn(Car, 'find').mockImplementation(findQuery('Car', 'cars', 'find', false));
  jest.spyOn(Customer, 'find').mockImplementation(findQuery('Customer', 'customers', 'find', false));
  jest.spyOn(Customer, 'findOne').mockImplementation(findQuery('Customer', 'customers', 'findOne', true));
  jest.spyOn(User, 'find').mockImplementation(findQuery('User', 'users', 'find', false));
  jest.spyOn(User, 'findOne').mockImplementation(findQuery('User', 'users', 'findOne', true));

  // Showroom settings (`getBaseSettings` reads this record). Only the capacity is configurable.
  jest.spyOn(SystemSetting, 'findOne').mockImplementation(() => new FakeQuery(async () => {
    const value = getDefaultBaseSettings();
    value.testDrive = { ...value.testDrive, maxGuestsPerSlot: state.capacity };
    return [{ value }];
  }, true));

  // `create(doc, opts)` → the row; `create([doc, …], { session })` → the rows. Inside a
  // transaction every inserted row is undone on abort.
  const insertOne = async (data, session) => {
    await record('Appointment', 'create', data);
    const doc = new Appointment(data);
    const error = doc.validateSync();
    if (error) throw error;
    if (state.codeUnique && state.appointments.some((row) => row.appointmentCode === doc.appointmentCode)) {
      throw duplicateKey('appointmentCode_1', { appointmentCode: 1 });
    }
    const raw = doc.toObject();
    raw.createdAt = state.now();
    raw.updatedAt = raw.createdAt;
    state.appointments.push(raw);
    try { assertUnique(raw); } catch (clash) { state.appointments.pop(); throw clash; }
    track(session, keyOf('Appointment', raw), () => {
      const at = state.appointments.indexOf(raw);
      if (at >= 0) state.appointments.splice(at, 1);
    });
    await record('Appointment', 'create', data, 'after');
    return clone(raw);
  };

  jest.spyOn(Appointment, 'create').mockImplementation(async (data, options) => {
    const session = options?.session;
    if (!Array.isArray(data)) return insertOne(data, session);
    const created = [];
    for (const item of data) created.push(await insertOne(item, session)); // eslint-disable-line no-await-in-loop
    return created;
  });

  // `findOneAndUpdate(filter, update, { new, session })`: atomic compare-and-set of ONE row.
  // Returns the updated row (`new: true`, the default here as before) or the row as it was
  // (`new: false`); null when nothing matched (the caller lost the race).
  jest.spyOn(Appointment, 'findOneAndUpdate').mockImplementation((filter, update, options = {}) => new FakeQuery(async () => {
    await record('Appointment', 'findOneAndUpdate', filter);
    const hit = state.appointments.find((doc) => matches(doc, filter));
    let before = null;
    if (hit) before = applyUpdate(hit, update, options.session, keyOf('Appointment', hit));
    await record('Appointment', 'findOneAndUpdate', filter, 'after');
    if (!hit) return [];
    return [options.new === false ? before : hit];
  }, true));

  jest.spyOn(Appointment, 'updateMany').mockImplementation(async (filter, update, options = {}) => {
    await record('Appointment', 'updateMany', filter);
    const hit = state.appointments.filter((doc) => matches(doc, filter));
    hit.forEach((doc) => applyUpdate(doc, update, options.session, keyOf('Appointment', doc)));
    await record('Appointment', 'updateMany', filter, 'after');
    return { acknowledged: true, matchedCount: hit.length, modifiedCount: hit.length };
  });

  jest.spyOn(Appointment, 'updateOne').mockImplementation(async (filter, update, options = {}) => {
    await record('Appointment', 'updateOne', filter);
    const hit = state.appointments.find((doc) => matches(doc, filter));
    if (hit) applyUpdate(hit, update, options.session, keyOf('Appointment', hit));
    await record('Appointment', 'updateOne', filter, 'after');
    return { acknowledged: true, matchedCount: hit ? 1 : 0, modifiedCount: hit ? 1 : 0 };
  });

  // The booking transaction writes the customer's document first, so that two requests of the
  // same customer collide (REQ-211).
  jest.spyOn(Customer, 'updateOne').mockImplementation(async (filter, update, options = {}) => {
    await record('Customer', 'updateOne', filter);
    const hit = state.customers.find((doc) => matches(doc, filter));
    if (hit) applyUpdate(hit, update, options.session, keyOf('Customer', hit));
    return { acknowledged: true, matchedCount: hit ? 1 : 0, modifiedCount: hit ? 1 : 0 };
  });

  let seq = 0;
  const id = () => new ObjectId();
  const add = (list, doc) => { state[list].push(doc); return doc; };

  return {
    state,
    get appointments() { return state.appointments; },
    get calls() { return state.calls; },
    mail,
    /** Waits for every background e-mail dispatched so far, then returns what was "sent". */
    flushMail: async () => { await mailService.awaitPendingMail(); return mail.sent; },
    set hook(fn) { state.hook = fn; },
    set now(fn) { state.now = fn; },
    /** `testDrive.maxGuestsPerSlot` returned by the settings. */
    set capacity(value) { state.capacity = value; },
    get capacity() { return state.capacity; },
    /** Turns on the partial unique indexes: `enableIndexes('car')`, `('seat')`, or both. */
    enableIndexes: (...flags) => { (flags.length ? flags : ['car', 'seat']).forEach((flag) => state.indexes.add(flag)); },
    disableIndexes: () => state.indexes.clear(),
    allowDuplicateCodes: () => { state.codeUnique = false; },
    /** Number of transactions that are open right now (should be 0 once a request ended). */
    get openTransactions() { return state.sessions.filter((session) => session.active).length; },

    addCar: (extra = {}) => add('cars', {
      _id: id(), vehicleCode: `TC-2026-${String(++seq).padStart(4, '0')}`, make: 'MAZDA', model: 'CX-5', variant: '2.0',
      year: 2020, status: 'AVAILABLE', isActive: true,
      images: [{ url: 'https://img.example/a.jpg', publicId: 'secret-id', isPrimary: true }],
      internalNotes: 'secret', floorPrice: 1, originalPrice: 2, priceHistory: [{ price: 1 }], vin: 'VIN123', licensePlate: '51A-000.00',
      ...extra,
    }),
    addCustomer: (extra = {}) => add('customers', { _id: id(), fullName: 'Khách Test', phone: '0900000000', email: 'k@example.com', ...extra }),
    addUser: (extra = {}) => add('users', { _id: id(), fullName: 'Nhân viên Test', ...extra }),
    addAppointment: (extra = {}) => {
      const doc = new Appointment({
        appointmentCode: `APT-${String(1000 + ++seq)}`, type: 'TEST_DRIVE', durationMinutes: 90, createdBy: id(), ...extra,
      });
      const error = doc.validateSync();
      if (error) throw error;
      const raw = doc.toObject();
      raw.createdAt = extra.createdAt ?? state.now();
      raw.updatedAt = extra.updatedAt ?? raw.createdAt;
      return add('appointments', raw);
    },

    /** Number of recorded queries matching `{model, method}`. */
    count: (model, method) => state.calls.filter((c) => c.model === model && (!method || c.method === method)).length,
    reset() {
      ['appointments', 'cars', 'customers', 'users', 'calls', 'sessions'].forEach((k) => { state[k].length = 0; });
      state.hook = null;
      state.now = () => new Date();
      state.capacity = 2;
      state.indexes.clear();
      state.codeUnique = true;
      state.locks.clear();
      mail.sent.length = 0;
      mail.fail = false;
      mail.delayMs = 0;
    },
  };
};

export default setupAppointmentFakes;
