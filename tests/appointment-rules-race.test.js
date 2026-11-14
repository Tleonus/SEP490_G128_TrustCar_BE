/**
 * @file appointment-rules-race.test.js
 * @description Exhaustive interleaving simulation of the save-then-recheck protocol (pure).
 * and an exhaustive interleaving simulation of the save-then-recheck protocol.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-008…012; AC-06…10, AC-11 logic)
 */

import {
  evaluateBooking, violationToError, Violation,
} from '../src/services/appointmentBookingRules.js';

const NOW = new Date('2026-11-08T00:00:00Z');
const SLOT = new Date('2026-11-10T03:00:00Z'); // 10:00 VN
const OTHER_SLOT = new Date('2026-11-10T06:00:00Z'); // 13:00 VN
const THIRD_SLOT = new Date('2026-11-11T03:00:00Z');
const FOURTH_SLOT = new Date('2026-11-11T06:00:00Z');

let seq = 0;
const row = (customer, car, scheduledAt, extra = {}) => ({
  _id: `row-${++seq}`, customer, car, scheduledAt, status: 'PENDING', isActive: true, ...extra,
});
const check = (args) => evaluateBooking({ scheduledAt: SLOT, now: NOW, mine: [], slotRows: [], customerRows: [], capacity: 2, ...args });

// ── Exhaustive interleaving of the save-then-recheck protocol (REQ-012) ─────

/** All orders of the 2n steps where each party's "insert" precedes its "recheck". */
const interleavings = (n) => {
  const out = [];
  const walk = (state, order) => {
    if (order.length === 2 * n) { out.push(order); return; }
    for (let p = 0; p < n; p += 1) {
      if (state[p] < 2) walk(state.map((s, i) => (i === p ? s + 1 : s)), [...order, [p, state[p]]]);
    }
  };
  walk(Array(n).fill(0), []);
  return out;
};

/** Runs one interleaving; returns the surviving (winning) rows and who won. */
const simulate = (parties, order, preRows = []) => {
  let rows = [...preRows];
  const written = parties.map(() => []);
  const won = parties.map(() => null);
  order.forEach(([p, step]) => {
    const party = parties[p];
    if (step === 0) {
      written[p] = party.carIds.map((car) => row(party.customer, car, SLOT));
      rows = rows.concat(written[p]);
      return;
    }
    const verdict = evaluateBooking({
      slotRows: rows, customerRows: rows.filter((r) => r.customer === party.customer),
      customerId: party.customer, carIds: party.carIds, scheduledAt: SLOT, now: NOW, capacity: 2,
      mine: written[p].map((r) => r._id),
    });
    won[p] = verdict === null;
    if (!won[p]) rows = rows.filter((r) => !written[p].includes(r));
  });
  return { rows, won };
};

describe('save-then-recheck protocol (REQ-012, AC-11)', () => {
  it('two customers racing for the same car: never both win (all 6 interleavings)', () => {
    const parties = [{ customer: 'A', carIds: ['c1'] }, { customer: 'B', carIds: ['c1'] }];
    const orders = interleavings(2);
    expect(orders).toHaveLength(6);
    orders.forEach((order) => {
      const { rows, won } = simulate(parties, order);
      expect(won.filter(Boolean).length).toBeLessThanOrEqual(1);
      expect(rows.filter((r) => r.car === 'c1')).toHaveLength(won.filter(Boolean).length);
    });
  });

  it('partial overlap (A: c1+c2, B: c2+c3): winners never share a car, no orphan rows', () => {
    const parties = [{ customer: 'A', carIds: ['c1', 'c2'] }, { customer: 'B', carIds: ['c2', 'c3'] }];
    interleavings(2).forEach((order) => {
      const { rows, won } = simulate(parties, order);
      expect(won.filter(Boolean).length).toBeLessThanOrEqual(1);
      expect(rows).toHaveLength(won.filter(Boolean).length * 2);
      expect(new Set(rows.map((r) => r.car)).size).toBe(rows.length);
    });
  });

  it('three customers on different cars: capacity 2 is never exceeded (all 90 interleavings)', () => {
    const parties = [
      { customer: 'A', carIds: ['c1'] }, { customer: 'B', carIds: ['c2'] }, { customer: 'C', carIds: ['c3'] },
    ];
    const orders = interleavings(3);
    expect(orders).toHaveLength(90);
    orders.forEach((order) => {
      const { rows } = simulate(parties, order);
      expect(new Set(rows.map((r) => r.customer)).size).toBeLessThanOrEqual(2);
    });
  });

  it('the same customer submitting twice (double click): at most one visit survives', () => {
    const parties = [{ customer: 'A', carIds: ['c1'] }, { customer: 'A', carIds: ['c1'] }];
    interleavings(2).forEach((order) => {
      const { rows } = simulate(parties, order);
      expect(rows.length).toBeLessThanOrEqual(1);
    });
  });

  it('a customer with one open visit racing two more slots never ends with more than 2 visits', () => {
    const base = row('A', 'x1', FOURTH_SLOT);
    const slots = [OTHER_SLOT, THIRD_SLOT];
    const written = [[], []];
    const won = [null, null];
    interleavings(2).forEach((order) => {
      let rows = [base];
      written[0] = []; written[1] = [];
      order.forEach(([p, step]) => {
        if (step === 0) {
          written[p] = [row('A', `n${p}`, slots[p])];
          rows = rows.concat(written[p]);
          return;
        }
        const verdict = evaluateBooking({
          slotRows: rows.filter((r) => r.scheduledAt === slots[p]), customerRows: rows, customerId: 'A',
          carIds: [`n${p}`], scheduledAt: slots[p], now: NOW, capacity: 2, mine: written[p].map((r) => r._id),
        });
        won[p] = verdict === null;
        if (!won[p]) rows = rows.filter((r) => !written[p].includes(r));
      });
      expect(new Set(rows.map((r) => r.scheduledAt.getTime())).size).toBeLessThanOrEqual(2);
    });
  });
});
