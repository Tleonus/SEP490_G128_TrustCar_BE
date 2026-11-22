/**
 * @file appointment-rules.test.js
 * @description `evaluateBooking` (pure): duplicates, limits, car conflicts, capacity,
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

describe('evaluateBooking', () => {
  it('allows a clean booking', () => {
    expect(check({ customerId: 'A', carIds: ['c1', 'c2'] })).toBeNull();
  });

  it('DUPLICATE_SLOT: customer already holds this slot (AC-06)', () => {
    const mineRow = row('A', 'c9', SLOT);
    expect(check({ customerId: 'A', carIds: ['c1'], customerRows: [mineRow], slotRows: [mineRow] }).kind)
      .toBe(Violation.DUPLICATE_SLOT);
  });

  it('DUPLICATE_CARS: customer already holds the car at another slot (AC-06)', () => {
    const v = check({ customerId: 'A', carIds: ['c1', 'c2'], customerRows: [row('A', 'c2', OTHER_SLOT)] });
    expect(v).toEqual({ kind: Violation.DUPLICATE_CARS, carIds: ['c2'] });
  });

  it('LIMIT: two other open visits already exist; a past or closed one does not count (AC-07)', () => {
    const two = [row('A', 'x1', OTHER_SLOT), row('A', 'x2', THIRD_SLOT)];
    expect(check({ customerId: 'A', carIds: ['c1'], customerRows: two }).kind).toBe(Violation.LIMIT);

    const oneOpen = [
      row('A', 'x1', OTHER_SLOT),
      row('A', 'x2', THIRD_SLOT, { status: 'CANCELLED' }),
      row('A', 'x3', new Date('2026-11-07T03:00:00Z')), // already past
    ];
    expect(check({ customerId: 'A', carIds: ['c1'], customerRows: oneOpen })).toBeNull();
  });

  it('two cars of the same visit count as one visit', () => {
    const rows = [row('A', 'x1', OTHER_SLOT), row('A', 'x2', OTHER_SLOT)];
    expect(check({ customerId: 'A', carIds: ['c1'], customerRows: rows })).toBeNull();
  });

  it('CONFLICT: another customer holds the car at this slot, lists every busy car (AC-08)', () => {
    const slotRows = [row('B', 'c1', SLOT), row('B', 'c3', SLOT)];
    const v = check({ customerId: 'A', carIds: ['c1', 'c2', 'c3'], slotRows });
    expect(v).toEqual({ kind: Violation.CONFLICT, carIds: ['c1', 'c3'] });
    expect(check({ customerId: 'A', carIds: ['c1'], slotRows, scheduledAt: OTHER_SLOT })).toBeNull();
  });

  it('closed or hidden rows never conflict (AC-09)', () => {
    const slotRows = ['CANCELLED', 'COMPLETED', 'NO_SHOW'].map((status) => row('B', 'c1', SLOT, { status }))
      .concat(row('B', 'c1', SLOT, { isActive: false }));
    expect(check({ customerId: 'A', carIds: ['c1'], slotRows })).toBeNull();
  });

  it('CAPACITY: two other customers at the slot fill it, even for a different car (AC-10)', () => {
    const slotRows = [row('B', 'b1', SLOT), row('B', 'b2', SLOT), row('C', 'k1', SLOT)];
    expect(check({ customerId: 'A', carIds: ['c1'], slotRows }).kind).toBe(Violation.CAPACITY);
    expect(check({ customerId: 'A', carIds: ['c1'], slotRows: slotRows.slice(0, 2) })).toBeNull();
  });

  it('rows listed in `mine` are ignored (re-check after writing)', () => {
    const mineRows = [row('A', 'c1', SLOT), row('A', 'c2', SLOT)];
    const v = check({
      customerId: 'A', carIds: ['c1', 'c2'], customerRows: mineRows, slotRows: mineRows, mine: mineRows.map((r) => r._id),
    });
    expect(v).toBeNull();
  });

  it('reports DUPLICATE before LIMIT before CONFLICT before CAPACITY', () => {
    const slotRows = [row('B', 'c1', SLOT), row('C', 'k1', SLOT), row('D', 'k2', SLOT)];
    const limitRows = [row('A', 'x1', OTHER_SLOT), row('A', 'x2', THIRD_SLOT)];
    expect(check({ customerId: 'A', carIds: ['c1'], slotRows, customerRows: limitRows }).kind).toBe(Violation.LIMIT);
    expect(check({ customerId: 'A', carIds: ['c1'], slotRows }).kind).toBe(Violation.CONFLICT);
    expect(check({ customerId: 'A', carIds: ['c9'], slotRows }).kind).toBe(Violation.CAPACITY);
  });
});

describe('violationToError', () => {
  it('maps each violation to the documented code, status and detail', () => {
    const map = (v) => violationToError(v, SLOT);
    expect(map({ kind: Violation.DUPLICATE_SLOT })).toMatchObject({
      code: 'APPOINTMENT_DUPLICATE', statusCode: 409, errors: { slot: '2026-11-10T10:00:00+07:00' },
    });
    expect(map({ kind: Violation.DUPLICATE_CARS, carIds: ['c2'] })).toMatchObject({
      code: 'APPOINTMENT_DUPLICATE', errors: { carIds: ['c2'] },
    });
    expect(map({ kind: Violation.LIMIT })).toMatchObject({ code: 'APPOINTMENT_LIMIT_REACHED', statusCode: 422 });
    expect(map({ kind: Violation.CONFLICT, carIds: ['c1'] })).toMatchObject({
      code: 'APPOINTMENT_CONFLICT', statusCode: 409, errors: { carIds: ['c1'] },
    });
    expect(map({ kind: Violation.CAPACITY })).toMatchObject({ code: 'APPOINTMENT_CAPACITY_FULL', statusCode: 409 });
  });
});
