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
 * - `verifyGoogleIdToken` (Firebase) is replaced by a stub whose next result
 *   is set per test (`h.google.next(...)`).
 * - Unique indexes of User (email, firebaseUid, customer, customer phone) are
 *   emulated: a violating write throws a MongoServerError-like E11000 error.
 *
 * Supported query surface (keep in sync with what the auth code actually uses):
 *   User:     findOne / findById / exists / create / updateOne / findOneAndUpdate / save
 *   Customer: find / findOne / findById / create / updateOne / deleteOne
 *   Role:     findOne (fixed in-memory roles)
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

  const google = { result: null };
  class GoogleTokenError extends Error {
    constructor(kind, message) { super(message); this.kind = kind; this.name = 'GoogleTokenError'; }
  }
  jest.unstable_mockModule('../../src/config/firebase.js', () => ({
    GoogleTokenError,
    verifyGoogleIdToken: jest.fn(async () => {
      const next = google.result;
      if (!next) throw new GoogleTokenError('INVALID', 'no stubbed Google identity');
      if (next instanceof Error) throw next;
      return { ...next };
    }),
    default: {},
  }));

  const { default: User }        = await import('../../src/models/User.js');
  const { default: Customer }    = await import('../../src/models/Customer.js');
  const { default: Role }        = await import('../../src/models/Role.js');
  const { default: ActivityLog } = await import('../../src/models/ActivityLog.js');
  const { default: app }         = await import('../../src/app.js');

  const users = new Map(); // id -> raw stored object
  const logs  = [];
  const hidden = Object.entries(User.schema.paths)
    .filter(([, schemaType]) => schemaType.options?.select === false)
    .map(([path]) => path);

  const findRaw = (filter) => [...users.values()].find((u) => matches(u, filter)) || null;
  const query = (resolver) => new FakeQuery(User, users, hidden, resolver);

  /** Emulates the unique indexes declared on User. */
  const assertUnique = (candidate, id) => {
    const others = [...users.values()].filter((u) => String(u._id) !== String(id));
    const rules = [
      ['email',       (u) => u.email === candidate.email],
      ['firebaseUid', (u) => typeof candidate.firebaseUid === 'string' && u.firebaseUid === candidate.firebaseUid],
      ['customer',    (u) => candidate.customer && u.customer && String(u.customer) === String(candidate.customer)],
      ['phone',       (u) => candidate.roleName === 'CUSTOMER' && typeof candidate.phone === 'string'
                              && u.roleName === 'CUSTOMER' && u.phone === candidate.phone],
    ];
    const hit = rules.find(([, clash]) => others.some(clash));
    if (hit) {
      const [field] = hit;
      throw Object.assign(new Error(`E11000 duplicate key error collection: users index: ${field}_1`), {
        name: 'MongoServerError', code: 11000, keyPattern: { [field]: 1 }, keyValue: { [field]: candidate[field] },
      });
    }
  };

  jest.spyOn(User, 'findOne').mockImplementation((filter) => query(() => findRaw(filter)));
  jest.spyOn(User, 'findById').mockImplementation((id) => query(() => users.get(String(id)) || null));

  jest.spyOn(User, 'exists').mockImplementation((filter) => {
    const raw = findRaw(filter);
    return Promise.resolve(raw ? { _id: raw._id } : null);
  });

  jest.spyOn(User, 'updateOne').mockImplementation((filter, update) => {
    const raw = findRaw(filter);
    if (raw) {
      const next = clone(raw);
      applyUpdate(next, update);
      assertUnique(next, raw._id);
      applyUpdate(raw, update);
    }
    return Promise.resolve({ acknowledged: true, matchedCount: raw ? 1 : 0, modifiedCount: raw ? 1 : 0 });
  });

  // Synchronous find + update = atomic with respect to other requests,
  // mirroring MongoDB's single-document atomicity.
  jest.spyOn(User, 'findOneAndUpdate').mockImplementation((filter, update, options = {}) => {
    const raw = findRaw(filter);
    let snapshot = null;
    if (raw) {
      const before = clone(raw);
      const next = clone(raw);
      applyUpdate(next, update);
      assertUnique(next, raw._id);
      applyUpdate(raw, update);
      snapshot = options.new ? raw : before;
    }
    return query(() => snapshot);
  });

  jest.spyOn(User.prototype, 'save').mockImplementation(async function save(options = {}) {
    if (this.isModified('password') && this.password) this.password = await User.hashPassword(this.password);
    if (options.validateBeforeSave !== false) await this.validate();

    const id = this._id.toString();
    const writeModified = (target) => {
      this.modifiedPaths().forEach((path) => {
        const value = this.get(path);
        if (value === undefined) unsetPath(target, path);
        else setPath(target, path, clone(value?.toObject ? value.toObject() : value));
      });
    };
    if (this.isNew || !users.has(id)) {
      const raw = this.toObject({ depopulate: true, virtuals: false });
      assertUnique(raw, id);
      users.set(id, raw);
    } else {
      const next = clone(users.get(id));
      writeModified(next);
      assertUnique(next, id);
      writeModified(users.get(id));
    }
    this.isNew = false;
    return this;
  });

  jest.spyOn(User, 'create').mockImplementation(async (data) => {
    const doc = new User(data);
    await doc.save();
    return doc;
  });

  const hashSpy = jest.spyOn(User, 'hashPassword');

  // ── Customer (showroom profiles) ───────────────────────────────────────────
  const customers = new Map();
  const customerList = (filter) => [...customers.values()].filter((c) => matches(c, filter));
  const listQuery = (resolver) => {
    const q = {
      select: () => q, sort: () => q, limit: () => q, lean: () => q, populate: () => q,
      then: (ok, ko) => Promise.resolve().then(resolver).then(ok, ko),
    };
    return q;
  };
  jest.spyOn(Customer, 'find').mockImplementation((filter) => listQuery(() => customerList(filter).map(clone)));
  jest.spyOn(Customer, 'findOne').mockImplementation((filter) => listQuery(() => clone(customerList(filter)[0] ?? null)));
  jest.spyOn(Customer, 'findById').mockImplementation((id) => listQuery(() => clone(customers.get(String(id)) ?? null)));
  jest.spyOn(Customer, 'create').mockImplementation(async (data) => {
    const doc = new Customer(data);
    await doc.validate();
    customers.set(doc._id.toString(), doc.toObject({ depopulate: true, virtuals: false }));
    return doc;
  });
  jest.spyOn(Customer, 'updateOne').mockImplementation(async (filter, update) => {
    const raw = customerList(filter)[0];
    if (raw) applyUpdate(raw, update);
    return { acknowledged: true, matchedCount: raw ? 1 : 0, modifiedCount: raw ? 1 : 0 };
  });
  jest.spyOn(Customer, 'deleteOne').mockImplementation(async (filter) => {
    const raw = customerList(filter)[0];
    if (raw) customers.delete(String(raw._id));
    return { acknowledged: true, deletedCount: raw ? 1 : 0 };
  });

  // ── Roles (fixed ids so tests can compare) ────────────────────────────────
  const roleIds = Object.fromEntries(
    ['ADMIN', 'SALES_STAFF', 'CUSTOMER'].map((name) => [name, new mongoose.Types.ObjectId()])
  );
  jest.spyOn(Role, 'findOne').mockImplementation((filter = {}) => listQuery(() => {
    const name = filter.name;
    return roleIds[name] && filter.isActive !== false ? { _id: roleIds[name], name, isActive: true } : null;
  }));

  jest.spyOn(ActivityLog, 'log').mockImplementation(async (entry) => { logs.push(entry); });

  let ipCounter = 0;

  const harness = {
    app,
    User,
    users,
    logs,
    mail,
    hashSpy,
    Customer,
    customers,
    roleIds,

    /** Controls the stubbed Firebase verification for the next calls. */
    google: {
      next(identity) { google.result = identity; },
      fail(kind) { google.result = new GoogleTokenError(kind, `stubbed ${kind}`); },
    },

    /** Clears all in-memory state between tests. */
    reset() {
      users.clear();
      logs.length = 0;
      mail.sent.length = 0;
      mail.fail = false;
      hashSpy.mockClear();
      customers.clear();
      google.result = null;
    },

    /** Inserts a valid user directly into the store (password hashed). */
    async createUser(overrides = {}) {
      // password: null → account without password (Google-only customer)
      const plain = overrides.password === null ? undefined : (overrides.password || 'TrustCar2026');
      const roleName = overrides.roleName || 'ADMIN';
      const doc = new User({
        fullName: 'Test User',
        email:    `user${users.size + 1}@trustcar.vn`,
        role:     roleIds[roleName],
        roleName,
        ...overrides,
        password: plain,
      });
      await doc.save();
      return { id: doc._id.toString(), email: doc.email, password: plain };
    },

    /** Inserts a showroom Customer directly into the store. */
    async createCustomer(overrides = {}) {
      const doc = await Customer.create({ fullName: 'Khach Showroom', phone: '0901234567', ...overrides });
      return doc._id.toString();
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
