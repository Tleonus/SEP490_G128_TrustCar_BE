/**
 * @file fakeAppointmentQuery.js
 * @description The query engine behind `fakeAppointmentModels.js`: filter matching and a
 * chainable query object that behaves like a Mongoose query for what the booking services use.
 *
 * Supported filters: equality, $in, $gt, $gte, $lt, $lte, $ne, $regex (+$options), $or,
 * $exists, $type ('number'), $nin (ObjectId/Date aware). Query chain: select (top-level names),
 * sort, skip, limit, lean, populate and session (the last two are accepted and ignored).
 */

import mongoose from 'mongoose';

const { ObjectId } = mongoose.Types;

export const norm = (v) => {
  if (v instanceof Date) return v.getTime();
  if (v instanceof ObjectId) return v.toString();
  return v;
};
const isOperatorObject = (c) =>
  c && typeof c === 'object' && !(c instanceof Date) && !(c instanceof ObjectId) && !Array.isArray(c);

const OPS = {
  $in: (v, arg) => arg.map(norm).includes(norm(v)),
  $gt: (v, arg) => norm(v) > norm(arg),
  $gte: (v, arg) => norm(v) >= norm(arg),
  $lt: (v, arg) => norm(v) < norm(arg),
  $lte: (v, arg) => norm(v) <= norm(arg),
  $ne: (v, arg) => norm(v) !== norm(arg),
  $nin: (v, arg) => !arg.map(norm).includes(norm(v)),
  $exists: (v, arg) => (v !== undefined) === Boolean(arg),
  $type: (v, arg) => (arg === 'number' ? typeof v === 'number' : typeof v === arg),
  $regex: (v, arg, cond) => new RegExp(arg, cond.$options ?? '').test(String(v ?? '')),
};

// `$options` only modifies `$regex`; `$or` is a list of alternative filters.
export const matches = (doc, filter) =>
  Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some((alternative) => matches(doc, alternative));
    if (!isOperatorObject(cond)) return norm(doc[key]) === norm(cond);
    return Object.entries(cond).every(([op, arg]) => op === '$options' || OPS[op](doc[key], arg, cond));
  });

export const clone = (v) => {
  if (v instanceof ObjectId || v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
};

export class FakeQuery {
  constructor(run, single = false) {
    this.run = run;
    this.single = single;
    this.fields = null;
    this.sorting = null;
    this.skipN = 0;
    this.limitN = null;
  }

  select(spec) { this.fields = String(spec).split(/\s+/).filter(Boolean); return this; }
  sort(spec) { this.sorting = spec; return this; }
  skip(n) { this.skipN = n; return this; }
  limit(n) { this.limitN = n; return this; }
  lean() { return this; }
  populate() { return this; }
  session() { return this; }

  async exec() {
    let rows = await this.run();
    if (this.sorting) {
      const [[key, dir]] = Object.entries(this.sorting);
      rows = [...rows].sort((a, b) => (norm(a[key]) < norm(b[key]) ? -dir : norm(a[key]) > norm(b[key]) ? dir : 0));
    }
    rows = rows.slice(this.skipN, this.limitN == null ? undefined : this.skipN + this.limitN);
    if (this.fields) {
      rows = rows.map((row) => Object.fromEntries(
        Object.entries(row).filter(([k]) => k === '_id' || this.fields.some((f) => f === k || f.startsWith(`${k}.`))),
      ));
    }
    const out = rows.map(clone);
    return this.single ? (out[0] ?? null) : out;
  }

  then(resolve, reject) { return this.exec().then(resolve, reject); }
}
