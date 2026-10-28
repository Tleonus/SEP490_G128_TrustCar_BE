/**
 * @file fakeAuthModels.js
 * @description Test harness for auth integration tests that run the REAL
 * Express app (routes → controllers → services → middlewares → validators)
 * without a MongoDB connection.
 *
 * Only the persistence layer is replaced:
 * - The real `User` Mongoose model is kept (schema defaults, virtuals,
 *   instance methods, `hashPassword` static); its query statics and
 *   `prototype.save` are re-implemented over an in-memory Map.
 * - `ActivityLog.log` writes to an in-memory array.
 * - `sendMail` (external side effect) is replaced by a recorder that can be
 *   switched into failure mode.
 *
 * Supported query surface (keep in sync with what the auth code actually uses):
 *   findOne / findById / exists / updateOne / findOneAndUpdate
 *   chain: .select('+a -b') .populate() .lean() and await
 *   update operators: $set, $unset, $inc
 *   filter operators: equality (dot paths), $gt, $gte, $lt, $lte, $ne
 *
 * Usage (top of a test file):
 *   import { setupAuthHarness } from './helpers/fakeAuthModels.js';
 *   const h = await setupAuthHarness();
 *   beforeEach(() => h.reset());
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';

// ── Environment required by the app before any src module is imported ──────
process.env.NODE_ENV           = 'test';
process.env.JWT_SECRET         = process.env.JWT_SECRET || 'test-secret-key-for-jest';
process.env.BCRYPT_SALT_ROUNDS = '4'; // fast hashing in tests

// ── Path helpers ────────────────────────────────────────────────────────────
const getPath = (obj, path) =>
  path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);

const setPath = (obj, path, value) => {
  const keys = path.split('.');
  let cur = obj;
  keys.slice(0, -1).forEach((k) => {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  });
  cur[keys[keys.length - 1]] = value;
};

const unsetPath = (obj, path) => {
  const keys = path.split('.');
  const parent = keys.length === 1 ? obj : getPath(obj, keys.slice(0, -1).join('.'));
  if (parent && typeof parent === 'object') delete parent[keys[keys.length - 1]];
};

/**
 * Deep clone that keeps BSON-ish values intact (the platform structured clone
 * turns an ObjectId into a plain object and breaks Mongoose casting).
 */
const clone = (v) => {
  if (v instanceof mongoose.Types.ObjectId) return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
};

/** Normalises ObjectId / Date / primitives so equality behaves like Mongo. */
const norm = (v) => {
  if (v instanceof Date) return v.getTime();
  if (v instanceof mongoose.Types.ObjectId) return v.toString();
  return v;
};

const isOperatorObject = (cond) =>
  cond !== null &&
  typeof cond === 'object' &&
  !(cond instanceof Date) &&
  !(cond instanceof mongoose.Types.ObjectId) &&
  Object.keys(cond).some((k) => k.startsWith('$'));

const matches = (doc, filter = {}) =>
  Object.entries(filter).every(([path, cond]) => {
    const actual = norm(getPath(doc, path));
    if (!isOperatorObject(cond)) return actual === norm(cond);
    return Object.entries(cond).every(([op, expected]) => {
      const e = norm(expected);
      switch (op) {
        case '$gt':  return actual !== undefined && actual >  e;
        case '$gte': return actual !== undefined && actual >= e;
        case '$lt':  return actual !== undefined && actual <  e;
        case '$lte': return actual !== undefined && actual <= e;
        case '$ne':  return actual !== e;
        default: throw new Error(`fakeAuthModels: unsupported filter operator ${op}`);
      }
    });
  });

const applyUpdate = (doc, update) => {
  const ops = Object.keys(update).some((k) => k.startsWith('$')) ? update : { $set: update };
  Object.entries(ops).forEach(([op, fields]) => {
    Object.entries(fields).forEach(([path, value]) => {
      switch (op) {
        case '$set':   setPath(doc, path, value); break;
        case '$unset': unsetPath(doc, path); break;
        case '$inc':   setPath(doc, path, (getPath(doc, path) ?? 0) + value); break;
        default: throw new Error(`fakeAuthModels: unsupported update operator ${op}`);
      }
    });
  });
};

/**
 * Builds the visible field set for a document given a `.select()` string,
 * honouring `select: false` schema paths exactly like Mongoose does.
 */
const project = (raw, hiddenByDefault, selectArg) => {
  const tokens = (selectArg || '').split(/\s+/).filter(Boolean);
  const include = tokens.filter((t) => t.startsWith('+')).map((t) => t.slice(1));
  const exclude = tokens.filter((t) => t.startsWith('-')).map((t) => t.slice(1));
  const out = clone(raw);
  hiddenByDefault.filter((p) => !include.includes(p)).forEach((p) => delete out[p]);
  exclude.forEach((p) => delete out[p]);
  return out;
};

/**
 * Chainable, awaitable stand-in for a Mongoose Query.
 * `resolver(selectArg)` returns the raw stored object (or null) – it is called
 * lazily on await so `.select()` placed anywhere in the chain is honoured.
 */
class FakeQuery {
  constructor(Model, store, hidden, resolver) {
    this.Model = Model;
    this.store = store;
    this.hidden = hidden;
    this.resolver = resolver;
    this.selectArg = '';
    this.isLean = false;
  }

  select(arg) { this.selectArg = `${this.selectArg} ${arg}`; return this; }

  populate() { return this; }

  lean() { this.isLean = true; return this; }

  async exec() {
    const raw = this.resolver();
    if (!raw) return null;
    const visible = project(raw, this.hidden, this.selectArg);
    if (this.isLean) return visible;
    // Hydrate with an inclusive projection: without it Mongoose fills schema
    // defaults (e.g. tokenVersion = 0) for unselected paths, which would hide
    // a missing `.select('+field')` in the code under test.
    const projection = Object.fromEntries(Object.keys(visible).map((k) => [k, 1]));
    return this.Model.hydrate(visible, projection);
  }

  then(resolve, reject) { return this.exec().then(resolve, reject); }
}

/**
 * Registers mocks, imports the real app and wires the in-memory persistence.
 * Must be awaited at the top level of a test file before anything from src/.
 */
export const setupAuthHarness = async () => {
  const mail = { sent: [], fail: false };

  jest.unstable_mockModule('../../src/config/mailer.js', () => ({
    sendMail: jest.fn(async (options) => {
      if (mail.fail) throw new Error('SMTP unavailable (simulated)');
      mail.sent.push(options);
    }),
    default: {},
  }));

  const { default: User }        = await import('../../src/models/User.js');
  const { default: ActivityLog } = await import('../../src/models/ActivityLog.js');
  const { default: app }         = await import('../../src/app.js');

  const users = new Map(); // id -> raw stored object
  const logs  = [];
  const hidden = Object.entries(User.schema.paths)
    .filter(([, schemaType]) => schemaType.options?.select === false)
    .map(([path]) => path);

  const findRaw = (filter) => [...users.values()].find((u) => matches(u, filter)) || null;
  const query = (resolver) => new FakeQuery(User, users, hidden, resolver);

  jest.spyOn(User, 'findOne').mockImplementation((filter) => query(() => findRaw(filter)));
  jest.spyOn(User, 'findById').mockImplementation((id) => query(() => users.get(String(id)) || null));

  jest.spyOn(User, 'exists').mockImplementation((filter) => {
    const raw = findRaw(filter);
    return Promise.resolve(raw ? { _id: raw._id } : null);
  });

  jest.spyOn(User, 'updateOne').mockImplementation((filter, update) => {
    const raw = findRaw(filter);
    if (raw) applyUpdate(raw, update);
    return Promise.resolve({ acknowledged: true, matchedCount: raw ? 1 : 0, modifiedCount: raw ? 1 : 0 });
  });

  // Synchronous find + update = atomic with respect to other requests,
  // mirroring MongoDB's single-document atomicity.
  jest.spyOn(User, 'findOneAndUpdate').mockImplementation((filter, update, options = {}) => {
    const raw = findRaw(filter);
    let snapshot = null;
    if (raw) {
      const before = clone(raw);
      applyUpdate(raw, update);
      snapshot = options.new ? raw : before;
    }
    return query(() => snapshot);
  });

  jest.spyOn(User.prototype, 'save').mockImplementation(async function save(options = {}) {
    if (this.isModified('password')) this.password = await User.hashPassword(this.password);
    if (options.validateBeforeSave !== false) await this.validate();

    const id = this._id.toString();
    if (this.isNew || !users.has(id)) {
      users.set(id, this.toObject({ depopulate: true, virtuals: false }));
    } else {
      const raw = users.get(id);
      this.modifiedPaths().forEach((path) => {
        const value = this.get(path);
        if (value === undefined) unsetPath(raw, path);
        else setPath(raw, path, clone(value?.toObject ? value.toObject() : value));
      });
    }
    this.isNew = false;
    return this;
  });

  const hashSpy = jest.spyOn(User, 'hashPassword');

  jest.spyOn(ActivityLog, 'log').mockImplementation(async (entry) => { logs.push(entry); });

  let ipCounter = 0;

  const harness = {
    app,
    User,
    users,
    logs,
    mail,
    hashSpy,

    /** Clears all in-memory state between tests. */
    reset() {
      users.clear();
      logs.length = 0;
      mail.sent.length = 0;
      mail.fail = false;
      hashSpy.mockClear();
    },

    /** Inserts a valid user directly into the store (password hashed). */
    async createUser(overrides = {}) {
      const plain = overrides.password || 'TrustCar2026';
      const doc = new User({
        fullName: 'Test User',
        email:    `user${users.size + 1}@trustcar.vn`,
        role:     new mongoose.Types.ObjectId(),
        roleName: 'ADMIN',
        ...overrides,
        password: plain,
      });
      await doc.save();
      return { id: doc._id.toString(), email: doc.email, password: plain };
    },

    /** Raw stored record (all fields, including select:false ones). */
    stored(id) { return users.get(String(id)); },

    /**
     * Gives each request its own client IP (app trusts one proxy hop) so the
     * auth rate limiter does not interfere with functional tests.
     */
    nextIp() { ipCounter += 1; return `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`; },
  };

  return harness;
};

export default { setupAuthHarness };
