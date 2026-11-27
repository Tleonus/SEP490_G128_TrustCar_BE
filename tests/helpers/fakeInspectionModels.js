/**
 * @file fakeInspectionModels.js
 * @description Test harness for inspection integration tests. Runs the REAL
 * Express app and inspection adapters on top of the auth harness, with
 * in-memory persistence for cars, inspections, forms, and audit.
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
 *   `forceCpoCollisions(n)` makes the next n certificate writes report a clash.
 *
 * Usage (top of a test file):
 *   import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';
 *   const h = await setupInspectionHarness();
 *   beforeEach(() => h.reset());
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAuthHarness } from './fakeAuthModels.js';
import { CPO_CRITERIA, InspectionResult } from '../../src/domain/inspection/criteria.js';

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
  if (path === '$or') return cond.some((branch) => matches(doc, branch));
  const actual = norm(getPath(doc, path));
  if (cond && typeof cond === 'object' && !(cond instanceof mongoose.Types.ObjectId) && '$in' in cond) {
    return cond.$in.map(norm).includes(actual);
  }
  if (cond && typeof cond === 'object' && !(cond instanceof mongoose.Types.ObjectId) && '$ne' in cond) {
    return actual !== norm(cond.$ne);
  }
  if (cond && typeof cond === 'object' && '$lt' in cond) return actual < norm(cond.$lt);
  return cond === null ? actual == null : actual === norm(cond);
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
  const { default: User } = await import('../../src/models/User.js');
  const { signAccessToken } = await import('../../src/utils/authTokens.js');
  const { FormTemplateHead, FormTemplateRevision, FormTemplateAudit, FormTemplateProposal } =
    await import('../../src/infra/inspection/formTemplateModel.js');
  const { default: CriterionResult } = await import('../../src/infra/inspection/inspectionResultModel.js');

  const cars = new Map();
  const records = new Map();
  const criterionResults = new Map();
  const formHeads = new Map();
  const formRevisions = new Map();
  const formProposals = new Map();
  const formAudit = [];
  const activity = [];
  const faults = { carSaves: [], cpoCollisions: 0, recordUpdates: 0 };
  const reads = { carFindOne: 0 };

  // ── Transactions: serialised fake sessions with snapshot/rollback ────────
  let lock = Promise.resolve();
  const copyMap = (map) => new Map([...map].map(([k, v]) => [k, clone(v)]));
  const restoreMap = (map, copied) => {
    map.clear();
    copied.forEach((value, key) => map.set(key, value));
  };
  const snapshot = () => ({
    cars: copyMap(cars), records: copyMap(records), criterionResults: copyMap(criterionResults),
    formHeads: copyMap(formHeads), formRevisions: copyMap(formRevisions), formProposals: copyMap(formProposals),
    activity: activity.length, formAudit: formAudit.length,
  });
  const restore = (snap) => {
    restoreMap(cars, snap.cars);
    restoreMap(records, snap.records);
    restoreMap(criterionResults, snap.criterionResults);
    restoreMap(formHeads, snap.formHeads);
    restoreMap(formRevisions, snap.formRevisions);
    restoreMap(formProposals, snap.formProposals);
    activity.length = snap.activity;
    formAudit.length = snap.formAudit;
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
    fakeQuery(Car, () => { reads.carFindOne += 1; return [...cars.values()].find((c) => matches(c, filter)) || null; }));
  jest.spyOn(Car, 'findOneAndUpdate').mockImplementation((filter, update, options = {}) => fakeQuery(Car, () => {
    const raw = [...cars.values()].find((car) => matches(car, filter));
    if (!raw) return null;
    const fields = update.$set;
    if (Object.hasOwn(fields, 'status') && faults.carSaves.length) throw faults.carSaves.shift();
    if (fields.cpoCertificateId && faults.cpoCollisions > 0) {
      faults.cpoCollisions -= 1;
      throw duplicateKeyError('cpoCertificateId_1', { cpoCertificateId: fields.cpoCertificateId });
    }
    const next = clone(raw);
    Object.entries(fields).forEach(([path, value]) => setPath(next, path, clone(value)));
    assertCarUnique(next);
    cars.set(String(next._id), next);
    return options.new ? next : raw;
  }));
  jest.spyOn(Car, 'exists').mockImplementation((filter) => {
    const forced = filter.cpoCertificateId && faults.cpoCollisions > 0;
    if (forced) faults.cpoCollisions -= 1;
    const hit = forced || [...cars.values()].find((c) => matches(c, filter));
    return {
      session: () => Promise.resolve(hit ? { _id: hit._id || 'forced' } : null),
      then: (ok, ko) => Promise.resolve(hit ? { _id: hit._id || 'forced' } : null).then(ok, ko),
    };
  });
  // KAN-98: self-heal write used by getHistoryReport when historyVerifyHash is null.
  jest.spyOn(Car, 'updateOne').mockImplementation(async (filter, update) => {
    const hit = [...cars.values()].find((c) => matches(c, filter));
    if (!hit) return { matchedCount: 0, modifiedCount: 0 };
    const sets = update?.$set || {};
    Object.entries(sets).forEach(([path, value]) => setPath(hit, path, clone(value)));
    return { matchedCount: 1, modifiedCount: 1 };
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
  jest.spyOn(InspectionRecord, 'updateOne').mockImplementation(async (filter, { $set }) => {
    const raw = recordList(filter)[0];
    if (!raw) return { matchedCount: 0 };
    Object.assign(raw, clone($set));
    return { matchedCount: 1 };
  });
  jest.spyOn(CriterionResult, 'find').mockImplementation((filter) =>
    fakeQuery(CriterionResult, () => [...criterionResults.values()].filter((row) => matches(row, filter))));
  jest.spyOn(CriterionResult, 'findOneAndUpdate').mockImplementation((filter, { $set }) =>
    fakeQuery(CriterionResult, () => {
      const key = `${filter.inspectionId}:${filter.criterionId}`;
      const doc = new CriterionResult({ ...criterionResults.get(key), ...filter, ...$set });
      const issue = doc.validateSync();
      if (issue) throw issue;
      const raw = doc.toObject();
      criterionResults.set(key, raw);
      return raw;
    }));
  // KAN-98: returns every matching record, chainable with .sort().lean().
  jest.spyOn(InspectionRecord, 'find').mockImplementation((filter) => {
    const list = recordList(filter);
    let sortSpec = null;
    const q = {
      sort(spec) { sortSpec = spec; return q; },
      lean: () => q,
      exec: async () => {
        const out = list.map(clone);
        if (sortSpec) {
          const [field, dir] = Object.entries(sortSpec)[0] || [];
          if (field) {
            out.sort((a, b) => {
              const av = getPath(a, field); const bv = getPath(b, field);
              if (av == null) return 1; if (bv == null) return -1;
              const cmp = av > bv ? 1 : av < bv ? -1 : 0;
              return dir < 0 ? -cmp : cmp;
            });
          }
        }
        return out;
      },
      then: (ok, ko) => q.exec().then(ok, ko),
    };
    return q;
  });
  jest.spyOn(InspectionRecord, 'create').mockImplementation(async (data) => {
    const list = Array.isArray(data) ? data : [data];
    const docs = [];
    for (const item of list) docs.push(await storeRecord(new InspectionRecord(item)));
    return Array.isArray(data) ? docs : docs[0];
  });
  // Synchronous match + write: atomic with respect to other requests (MongoDB
  // single-document atomicity), which is what the "only one submit wins" rule relies on.
  jest.spyOn(InspectionRecord, 'findOneAndUpdate').mockImplementation((filter, update, options = {}) => {
    if (faults.recordUpdates > 0) {
      faults.recordUpdates -= 1;
      return fakeQuery(InspectionRecord, () => { throw new Error('Simulated inspection update failure'); });
    }
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

  // Both templates are fixtures. These models back the actual repository used by the app.
  const templateId = (key, rev) => `${key}:${rev}`;
  function seedTemplate(key) {
    const groups = CPO_CRITERIA.map((criterion) => ({
      ...criterion,
      questions: [{
        id: `${key}-${criterion.key}`, label: 'Kết quả', type: 'SINGLE_CHOICE', required: true,
        config: { options: [
          { id: 'pass', label: 'Đạt', result: InspectionResult.PASS },
          { id: 'fail', label: 'Không đạt', result: InspectionResult.FAIL },
          { id: 'unchecked', label: 'Chưa kiểm tra', result: InspectionResult.NOT_CHECKABLE },
        ] },
      }],
    }));
    formHeads.set(key, { templateKey: key, revision: 1 });
    formRevisions.set(templateId(key, 1), {
      templateKey: key, revision: 1, groups, retiredIds: { questions: [], options: [] },
    });
  }
  jest.spyOn(FormTemplateHead, 'findOne').mockImplementation((filter) =>
    fakeQuery(FormTemplateHead, () => formHeads.get(filter.templateKey)));
  jest.spyOn(FormTemplateRevision, 'findOne').mockImplementation((filter) =>
    fakeQuery(FormTemplateRevision, () => formRevisions.get(templateId(filter.templateKey, filter.revision))));
  jest.spyOn(FormTemplateRevision, 'findById').mockImplementation((id) =>
    fakeQuery(FormTemplateRevision, () => [...formRevisions.values()].find((row) => String(row._id) === String(id))));
  jest.spyOn(FormTemplateProposal, 'create').mockImplementation(async ([entry]) => {
    const doc = new FormTemplateProposal(entry);
    await doc.validate();
    formProposals.set(String(doc._id), doc.toObject());
    return [doc];
  });
  const proposalFor = (filter) => [...formProposals.values()].find((row) => matches(row, filter));
  jest.spyOn(FormTemplateProposal, 'findOne').mockImplementation((filter) =>
    fakeQuery(FormTemplateProposal, () => proposalFor(filter)));
  jest.spyOn(FormTemplateProposal, 'findById').mockImplementation((id) =>
    fakeQuery(FormTemplateProposal, () => formProposals.get(String(id))));
  jest.spyOn(FormTemplateProposal, 'findOneAndUpdate').mockImplementation((filter, update) =>
    fakeQuery(FormTemplateProposal, () => {
      const row = proposalFor(filter);
      return row ? Object.assign(row, clone(update.$set)) : null;
    }));
  jest.spyOn(FormTemplateProposal, 'find').mockImplementation((filter, projection) => {
    let rows = [...formProposals.values()].filter((row) => matches(row, filter));
    return {
      sort({ _id: direction }) {
        rows.sort((a, b) => direction * String(a._id).localeCompare(String(b._id)));
        return this;
      },
      limit(count) { rows = rows.slice(0, count); return this; },
      async lean() {
        return rows.map((row) => {
          const result = clone(row);
          if (projection === '-groups') delete result.groups;
          return result;
        });
      },
    };
  });
  jest.spyOn(FormTemplateHead, 'updateOne').mockImplementation(async (filter, update) => {
    const head = formHeads.get(filter.templateKey);
    if (!head || !matches(head, filter)) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(head, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
  });
  jest.spyOn(FormTemplateRevision, 'create').mockImplementation(async (entries) => {
    const docs = entries.map((entry) => new FormTemplateRevision(entry));
    for (const doc of docs) {
      await doc.validate();
      const key = templateId(doc.templateKey, doc.revision);
      if (formRevisions.has(key)) throw duplicateKeyError('template_revision', { templateKey: doc.templateKey, revision: doc.revision });
      formRevisions.set(key, doc.toObject());
    }
    return docs;
  });
  jest.spyOn(FormTemplateAudit, 'create').mockImplementation(async (entries) => {
    formAudit.push(...entries.map(clone));
    return entries;
  });

  // ── ActivityLog (transactional create + read for history report) ──────────
  jest.spyOn(ActivityLog, 'create').mockImplementation(async (data) => {
    const list = Array.isArray(data) ? data : [data];
    list.forEach((entry) => activity.push(clone(entry)));
    return list;
  });
  // KAN-98: bulk inspector lookup. Delegates to the auth harness's User.findById
  // mock so the in-memory user store stays the single source of truth.
  jest.spyOn(User, 'find').mockImplementation((filter) => {
    const ids = filter?._id?.$in || [];
    const q = {
      select: () => q,
      lean: () => q,
      exec: async () => {
        const out = [];
        for (const id of ids) {
          // eslint-disable-next-line no-await-in-loop
          const doc = await User.findById(id).select('fullName').lean();
          if (doc) out.push(doc);
        }
        return out;
      },
      then: (ok, ko) => q.exec().then(ok, ko),
    };
    return q;
  });

  jest.spyOn(ActivityLog, 'find').mockImplementation((filter) => {
    const list = activity.filter((entry) => matches(entry, filter));
    const q = {
      lean: () => q,
      exec: async () => list.map(clone),
      then: (ok, ko) => q.exec().then(ok, ko),
    };
    return q;
  });

  const harness = {
    ...auth,
    Car,
    InspectionRecord,
    cars,
    records,
    activity,
    formAudit,
    sessionStats,

    useCriteriaTemplate(revision = 2) {
      const templateKey = 'GASOLINE';
      const groups = [
        ...CPO_CRITERIA.map(({ key, label }) => ({ key, label, required: true })),
        { key: 'G6_BODYWORK', label: 'Thân vỏ', required: true },
        ...(revision > 2 ? [{ key: 'G7_EXTRA', label: 'Hạng mục bổ sung', required: true }] : []),
      ];
      formHeads.set(templateKey, { templateKey, revision });
      formRevisions.set(templateId(templateKey, revision), { templateKey, revision, format: 'CRITERIA', groups });
      return groups;
    },

    mockCertificateRevisionRead(read) {
      const headRead = FormTemplateHead.findOne;
      headRead.mockClear();
      formHeads.set('GASOLINE', { templateKey: 'GASOLINE', revision: 2 });
      return { headRead, aggregate: jest.spyOn(FormTemplateRevision, 'aggregate').mockImplementation(read) };
    },

    reset() {
      auth.reset();
      cars.clear();
      records.clear();
      criterionResults.clear();
      activity.length = 0;
      formHeads.clear();
      formRevisions.clear();
      formProposals.clear();
      formAudit.length = 0;
      ['GASOLINE', 'ELECTRIC'].forEach(seedTemplate);
      faults.carSaves.length = 0;
      faults.cpoCollisions = 0;
      faults.recordUpdates = 0;
      reads.carFindOne = 0;
      Object.keys(sessionStats).forEach((k) => { sessionStats[k] = 0; });
    },

    /** Inserts a car straight into the store; returns its id. */
    createCar(overrides = {}) {
      const doc = new Car({
        make: 'Toyota', model: 'Vios', variant: '1.5G', year: 2020, mileage: 50000,
        specifications: { color: 'Trắng' }, status: 'INCOMING', fuelType: 'GASOLINE',
        updatedAt: new Date(), ...overrides,
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
    async loginAs(roleName = 'SALES_STAFF', roleNames = null) {
      const names = roleNames || [roleName];
      const { id, email } = await auth.createUser({ roleName, roleNames: names });
      const token = signAccessToken({ _id: id, email, roleName, roleNames: names, tokenVersion: 0 });
      return { id, token, auth: `Bearer ${token}` };
    },

    /** Simulates populated Role documents instead of the fallback ObjectIds. */
    setPopulatedRoles(id, permissionsByRole) {
      auth.stored(id).roles = Object.entries(permissionsByRole).map(([name, permissions]) => ({
        _id: auth.roleIds[name], name, permissions: [...permissions],
      }));
    },

    fillDraft(id, confirmed = {}) {
      const record = records.get(String(id));
      const definition = formRevisions.get(templateId(record.templateKey, Number(record.checklistVersion)));
      const photo = (name) => `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/v1/trustcar/inspections/${id}/${name}.jpg`;
      record.vehicleInfo.confirmed = { ...record.vehicleInfo.original, ...confirmed };
      record.overviewPhotos = Object.fromEntries(['FRONT', 'REAR', 'LEFT', 'RIGHT'].map((position) => [position, photo(position)]));
      record.answers = definition.groups.map(({ questions }) => ({ questionId: questions[0].id, value: 'pass' }));
      record.groups = definition.groups.map(({ key }) => ({
        groupKey: key, note: key === 'G1_BODY_FRAME' ? 'Thân vỏ tốt' : '', photos: [photo(key)],
        odometerPhoto: key === 'G4_ODOMETER' ? photo('odometer') : null, items: [], minorDefects: [], passed: null,
      }));
      return record;
    },

    /** Makes the next `count` Car saves throw `error` (default: a generic write failure). */
    failNextCarSaves(count = 1, error = null) {
      for (let i = 0; i < count; i += 1) faults.carSaves.push(error || new Error('Simulated write failure'));
    },

    /** Makes the next `count` CPO-code uniqueness checks report the code as taken. */
    forceCpoCollisions(count) { faults.cpoCollisions = count; },
    failNextInspectionUpdate() { faults.recordUpdates += 1; },

    duplicateKeyError,
    reads,
    car(id) { return cars.get(String(id)); },
    record(id) { return records.get(String(id)); },
  };

  return harness;
};

export default { setupInspectionHarness };
