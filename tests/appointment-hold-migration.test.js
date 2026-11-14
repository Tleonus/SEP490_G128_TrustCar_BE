/**
 * @file appointment-hold-migration.test.js
 * @description The pure part of the hold migration: which rows get which fields, which situations
 * block the unique indexes, idempotence, and what the report says.
 *
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-222
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#AC-31
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#AC-32
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#AC-33
 */

import { groupVisits, findDuplicates, planBackfill, buildReport, formatReport } from '../src/migrations/appointmentHolds.js';
import { holdViolations } from './helpers/appointmentInvariants.js';

const T1 = new Date('2026-11-10T03:00:00Z');
const T2 = new Date('2026-11-10T06:00:00Z');
let n = 0;
const row = (customer, car, scheduledAt, extra = {}) => ({
  _id: `id-${++n}`, appointmentCode: `APT-${String(1000 + n).padStart(4, '0')}`, customer, car, scheduledAt,
  status: 'PENDING', isActive: true, type: 'TEST_DRIVE', ...extra,
});

/** Applies the plan the way the script does (only `$set`), so a second plan can be computed. */
const apply = (rows, plan) => rows.map((r) => {
  const update = plan.updates.find((u) => u._id === r._id);
  return update ? { ...r, ...update.set } : r;
});

describe('planBackfill: what gets written', () => {
  it('a plain KAN-16 visit: every row gets holdsCar, the lowest code gets seat 1', () => {
    const rows = [row('anna', 'c1', T1), row('anna', 'c2', T1), row('anna', 'c3', T1)];
    const plan = planBackfill(rows, 3);
    expect(plan.updates).toEqual([
      { _id: rows[0]._id, appointmentCode: rows[0].appointmentCode, set: { holdsCar: true, visitSeat: 1 } },
      { _id: rows[1]._id, appointmentCode: rows[1].appointmentCode, set: { holdsCar: true } },
      { _id: rows[2]._id, appointmentCode: rows[2].appointmentCode, set: { holdsCar: true } },
    ]);
    expect(plan.assigned).toEqual([{ code: rows[0].appointmentCode, seat: 1, scheduledAt: T1 }]);
  });

  it('an old KAN-28 row keeps its seat: slotSeat 2 becomes visitSeat 2, nothing else changes (AC-33)', () => {
    const old = row('ben', 'c1', T1, { slotSeat: 2, assignedTo: 'staff' });
    const plan = planBackfill([old], 3);
    expect(plan.updates).toEqual([{ _id: old._id, appointmentCode: old.appointmentCode, set: { holdsCar: true, visitSeat: 2 } }]);
    expect(plan.assigned).toEqual([]); // no new seat was invented
    expect(Object.keys(plan.updates[0].set).sort()).toEqual(['holdsCar', 'visitSeat']); // only these two fields
  });

  it('visits without a seat get the smallest FREE seat of their slot, around seats that already exist', () => {
    const rows = [
      row('a', 'c1', T1), row('b', 'c2', T1, { slotSeat: 1 }), row('c', 'c3', T1), // seat 1 is taken by b
      row('d', 'c4', T2),
    ];
    const plan = planBackfill(rows, 3);
    const seats = Object.fromEntries(plan.assigned.map((s) => [s.code, s.seat]));
    expect(seats[rows[0].appointmentCode]).toBe(2);
    expect(seats[rows[2].appointmentCode]).toBe(3);
    expect(seats[rows[3].appointmentCode]).toBe(1); // another slot starts again at 1
  });

  it('is deterministic: the same rows in any order give the same assignment', () => {
    const rows = [row('a', 'c1', T1), row('b', 'c2', T1), row('c', 'c3', T1)];
    const forward = planBackfill(rows, 3).assigned.map((s) => [s.code, s.seat]);
    const reversed = planBackfill([...rows].reverse(), 3).assigned.map((s) => [s.code, s.seat]);
    expect(reversed).toEqual(forward);
  });

  it('writes nothing for rows that are already right', () => {
    const done = row('a', 'c1', T1, { holdsCar: true, visitSeat: 1 });
    expect(planBackfill([done], 3).updates).toEqual([]);
  });

  it('a row that holds the car but lacks the seat only gets the seat; a non-lead row with the car is left alone', () => {
    const lead = row('a', 'c1', T1, { holdsCar: true });
    const second = row('a', 'c2', T1, { holdsCar: true });
    const plan = planBackfill([lead, second], 3);
    expect(plan.updates).toEqual([{ _id: lead._id, appointmentCode: lead.appointmentCode, set: { visitSeat: 1 } }]);
  });

  it('reports seats above the current capacity but keeps them (a lowered capacity is allowed)', () => {
    const rows = [row('a', 'c1', T1, { slotSeat: 3 })];
    const plan = planBackfill(rows, 2);
    expect(plan.overCapacity).toEqual([{ code: rows[0].appointmentCode, seat: 3, scheduledAt: T1 }]);
    expect(plan.updates[0].set.visitSeat).toBe(3);
  });

  it('notes a visit whose other rows also carry a seat, and leaves them untouched', () => {
    const rows = [row('a', 'c1', T1, { slotSeat: 1 }), row('a', 'c2', T1, { slotSeat: 2 })];
    const plan = planBackfill(rows, 3);
    expect(plan.anomalies).toHaveLength(1);
    expect(plan.updates.map((u) => u._id)).toEqual(rows.map((r) => r._id)); // holdsCar for both, seat for the lead
    expect(plan.updates[1].set).toEqual({ holdsCar: true }); // no seat change on the non-lead row
  });
});

describe('idempotence and the invariants (AC-32)', () => {
  const scenario = () => [
    row('a', 'c1', T1), row('a', 'c2', T1), row('b', 'c3', T1, { slotSeat: 2 }), row('c', 'c4', T2), row('d', 'c5', T1),
  ];

  it('applying the plan twice: the second plan is empty and nothing changes again', () => {
    const rows = scenario();
    const first = planBackfill(rows, 3);
    const after = apply(rows, first);
    const second = planBackfill(after, 3);
    expect(second.updates).toEqual([]);
    expect(second.assigned).toEqual([]);
    expect(apply(after, second)).toEqual(after);
  });

  it('after the migration the hold invariants hold for every open visit', () => {
    const rows = scenario();
    const after = apply(rows, planBackfill(rows, 3));
    // slotSeat of the old row stays (KAN-28 data is never deleted); the check only reads it as a seat
    expect(holdViolations(after)).toEqual([]);
  });

  it('closed rows are never part of the input and so never written (the script selects open rows only)', () => {
    expect(planBackfill([], 3).updates).toEqual([]);
  });
});

describe('findDuplicates (AC-31)', () => {
  it('a car booked twice at the same time by different customers is reported with both codes', () => {
    const a = row('anna', 'car-x', T1);
    const b = row('ben', 'car-x', T1);
    const dup = findDuplicates([a, b, row('anna', 'car-y', T1)]);
    expect(dup.car).toHaveLength(1);
    expect(dup.car[0]).toMatchObject({ car: 'car-x', scheduledAt: T1 });
    expect(dup.car[0].codes).toEqual([a.appointmentCode, b.appointmentCode].sort());
    expect(dup.seat).toEqual([]);
  });

  it('the same car at different times, or different cars at the same time, is fine', () => {
    expect(findDuplicates([row('a', 'x', T1), row('b', 'x', T2), row('c', 'y', T1)])).toEqual({ car: [], seat: [] });
  });

  it('two visits already holding the same seat at the same time are reported', () => {
    const a = row('anna', 'c1', T1, { slotSeat: 1 });
    const b = row('ben', 'c2', T1, { visitSeat: 1 });
    const dup = findDuplicates([a, b]);
    expect(dup.seat).toHaveLength(1);
    expect(dup.seat[0]).toMatchObject({ seat: 1, scheduledAt: T1 });
  });

  it('the same seat number at different times is fine', () => {
    expect(findDuplicates([row('a', 'c1', T1, { slotSeat: 1 }), row('b', 'c2', T2, { slotSeat: 1 })]).seat).toEqual([]);
  });

  it('finding duplicates writes nothing: it only reads rows', () => {
    const rows = [row('anna', 'car-x', T1), row('ben', 'car-x', T1)];
    const frozen = JSON.stringify(rows);
    findDuplicates(rows);
    planBackfill(rows, 3);
    expect(JSON.stringify(rows)).toBe(frozen);
  });
});

describe('groupVisits', () => {
  it('a visit is one customer at one start time', () => {
    const groups = groupVisits([row('a', 'c1', T1), row('a', 'c2', T1), row('a', 'c3', T2), row('b', 'c4', T1)]);
    expect(groups.map((g) => g.length).sort()).toEqual([1, 1, 2]);
  });
});

describe('buildReport / formatReport', () => {
  const make = (rows, capacity = 3, extra = {}) => buildReport({
    dbName: 'trustcar', rows, capacity, duplicates: findDuplicates(rows), plan: planBackfill(rows, capacity), ...extra,
  });

  it('counts rows, visits, types, what will be written, and says apply may run when clean', () => {
    const report = make([row('a', 'c1', T1), row('a', 'c2', T1), row('b', 'c3', T2, { type: 'VIEWING' })]);
    expect(report).toMatchObject({
      dbName: 'trustcar', openRows: 3, openVisits: 2, rowsToUpdate: 3, blocked: false,
      openRowsByType: { TEST_DRIVE: 2, VIEWING: 1 },
    });
    expect(report.seatsToAssign).toHaveLength(2);
    expect(formatReport(report).at(-1)).toMatch(/--apply can run/);
  });

  it('prints the stored capacity so the Human can compare it with the old fixed 2', () => {
    const lines = formatReport(make([row('a', 'c1', T1)], 3, { capacitySource: 'stored' }));
    expect(lines).toContain('maxGuestsPerSlot: 3 (stored)');
    expect(formatReport(make([], null, { capacitySource: 'unknown' }))).toContain('maxGuestsPerSlot: unknown (unknown)');
  });

  it('duplicates make the report BLOCKED and list them', () => {
    const report = make([row('anna', 'car-x', T1), row('ben', 'car-x', T1)]);
    expect(report.blocked).toBe(true);
    const text = formatReport(report).join('\n');
    expect(text).toMatch(/BLOCKING 1 car\(s\) booked twice/);
    expect(text).toMatch(/blocked - resolve the duplicates/);
  });

  it('never prints customer names, e-mails, or a connection string: codes and ids only', () => {
    const text = formatReport(make([row('a', 'c1', T1, { notes: 'secret note', fullName: 'X' })])).join('\n');
    expect(text).not.toMatch(/secret note|mongodb|@/);
  });

  it('an empty database is a clean, empty report', () => {
    const report = make([]);
    expect(report).toMatchObject({ openRows: 0, rowsToUpdate: 0, blocked: false });
  });
});
