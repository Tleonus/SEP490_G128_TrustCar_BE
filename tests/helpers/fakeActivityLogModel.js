/**
 * @file fakeActivityLogModel.js
 * @description In-memory stand-in for the read side of the ActivityLog model (KAN-40 tests).
 *
 * Read methods used by the admin endpoints are faked: find / countDocuments / findById / distinct.
 * Supported in filters: equality (ObjectId and Date aware), RegExp values, $gte / $lt / $in / $ne …
 * (reusing `matches` of fakeAppointmentQuery.js). Query chain: sort (several keys), skip, limit, lean.
 *
 * Every WRITE method of the model is replaced by a spy that throws and counts, so a test can prove
 * that a read-only endpoint never writes (REQ-011). Calls to `ActivityLog.log` are counted by the
 * auth harness (`h.logs`), not here.
 *
 * Must be awaited AFTER `setupAuthHarness()` when used together with it (same rule as the other helpers).
 */

import mongoose from 'mongoose';
import { clone, matches, norm } from './fakeAppointmentQuery.js';

const { ObjectId } = mongoose.Types;

const WRITE_METHODS = [
  'create', 'insertMany', 'updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne',
  'deleteOne', 'deleteMany', 'findOneAndDelete', 'findByIdAndUpdate', 'findByIdAndDelete', 'bulkWrite',
];

const matchesFilter = (doc, filter = {}) => Object.entries(filter).every(([key, cond]) => {
  if (cond instanceof RegExp) return typeof doc[key] === 'string' && cond.test(doc[key]);
  return matches(doc, { [key]: cond });
});

const compare = (a, b) => (norm(a) < norm(b) ? -1 : norm(a) > norm(b) ? 1 : 0);

class FakeLogQuery {
  constructor(run, single = false) { this.run = run; this.single = single; this.sorting = null; this.skipN = 0; this.limitN = null; }

  sort(spec) { this.sorting = spec; return this; }
  skip(n) { this.skipN = n; return this; }
  limit(n) { this.limitN = n; return this; }
  lean() { return this; }

  async exec() {
    let list = [...this.run()];
    if (this.sorting) {
      const keys = Object.entries(this.sorting);
      list.sort((a, b) => {
        for (const [key, dir] of keys) {
          const result = compare(a[key], b[key]);
          if (result !== 0) return result * dir;
        }
        return 0;
      });
    }
    list = list.slice(this.skipN, this.limitN === null ? undefined : this.skipN + this.limitN).map(clone);
    return this.single ? (list[0] ?? null) : list;
  }

  then(resolve, reject) { return this.exec().then(resolve, reject); }
}

/**
 * @param {import('mongoose').Model} ActivityLog the real model (its methods are replaced)
 * @returns {Promise<{ rows: object[], addLog: Function, reset: Function, reads: { count: number }, writes: { count: number, calls: string[] } }>}
 */
export const setupActivityLogFake = async (ActivityLog) => {
  const { jest } = await import('@jest/globals');
  const rows = [];
  const reads = { count: 0 };
  const writes = { count: 0, calls: [] };

  jest.spyOn(ActivityLog, 'find').mockImplementation((filter) => {
    reads.count += 1;
    return new FakeLogQuery(() => rows.filter((row) => matchesFilter(row, filter)));
  });
  jest.spyOn(ActivityLog, 'countDocuments').mockImplementation(async (filter) => {
    reads.count += 1;
    return rows.filter((row) => matchesFilter(row, filter)).length;
  });
  jest.spyOn(ActivityLog, 'findById').mockImplementation((id) => {
    reads.count += 1;
    return new FakeLogQuery(() => rows.filter((row) => String(row._id) === String(id)), true);
  });
  jest.spyOn(ActivityLog, 'distinct').mockImplementation(async (field) => {
    reads.count += 1;
    const seen = new Map();
    for (const row of rows) if (row[field] !== undefined) seen.set(String(norm(row[field])), row[field]);
    return [...seen.values()];
  });

  for (const name of WRITE_METHODS) {
    jest.spyOn(ActivityLog, name).mockImplementation(() => {
      writes.count += 1;
      writes.calls.push(name);
      throw new Error(`ActivityLog.${name} must not be called by a read-only endpoint`);
    });
  }

  let tick = 0;
  /** Adds a stored log entry; `createdAt` defaults to an increasing instant so the order is predictable. */
  const addLog = (partial = {}) => {
    tick += 1;
    const doc = {
      _id: new ObjectId(),
      eventType: 'USER_LOGIN',
      performedBy: null,
      performedByEmail: null,
      targetModel: null,
      targetId: null,
      targetCode: null,
      changes: null,
      summary: null,
      ipAddress: null,
      userAgent: null,
      metadata: null,
      createdAt: new Date(Date.UTC(2026, 10, 1) + tick * 60000),
      ...partial,
    };
    rows.push(doc);
    return doc;
  };

  const reset = () => {
    rows.length = 0;
    tick = 0;
    reads.count = 0;
    writes.count = 0;
    writes.calls.length = 0;
  };

  return { rows, addLog, reset, reads, writes };
};

export default { setupActivityLogFake };
