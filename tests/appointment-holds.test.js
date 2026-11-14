/**
 * @file appointment-holds.test.js
 * @description Pure hold bookkeeping: which seat a new visit gets, which row of a visit carries
 * it, what a new open row stores, and what closing a row releases.
 *
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-212
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-214
 */

import { RELEASE_HOLDS, seatOf, pickVisitSeat, leadRowOf, holdFields } from '../src/services/appointmentHolds.js';

const open = (extra = {}) => ({ status: 'PENDING', isActive: true, ...extra });

describe('seatOf', () => {
  test('reads visitSeat, falls back to slotSeat of an old KAN-28 row, else null', () => {
    expect(seatOf({ visitSeat: 2 })).toBe(2);
    expect(seatOf({ slotSeat: 3 })).toBe(3);
    expect(seatOf({ visitSeat: 1, slotSeat: 3 })).toBe(1);
    expect(seatOf({})).toBeNull();
  });
});

describe('pickVisitSeat', () => {
  test('empty slot gives seat 1', () => {
    expect(pickVisitSeat([], 3)).toBe(1);
  });

  test('gives the smallest seat nobody holds', () => {
    expect(pickVisitSeat([open({ visitSeat: 1 }), open({ visitSeat: 3 })], 3)).toBe(2);
    expect(pickVisitSeat([open({ visitSeat: 2 })], 3)).toBe(1);
  });

  test('rows without a seat (the other cars of a visit) hold nothing', () => {
    expect(pickVisitSeat([open({ visitSeat: 1 }), open({}), open({})], 2)).toBe(2);
  });

  test('every seat taken gives null', () => {
    expect(pickVisitSeat([open({ visitSeat: 1 }), open({ visitSeat: 2 })], 2)).toBeNull();
  });

  test('an old KAN-28 row still counts through its slotSeat (AC-19)', () => {
    expect(pickVisitSeat([open({ slotSeat: 1 }), open({ slotSeat: 2 })], 3)).toBe(3);
  });

  test('rows that are no longer open never hold a seat', () => {
    const rows = [{ status: 'CANCELLED', isActive: true, visitSeat: 1 }, { status: 'PENDING', isActive: false, visitSeat: 2 }];
    expect(pickVisitSeat(rows, 2)).toBe(1);
  });

  test('a lowered capacity keeps the seat above it taken and still finds a free one below', () => {
    // capacity was 3, is now 2: one visit still holds seat 3
    expect(pickVisitSeat([open({ visitSeat: 3 })], 2)).toBe(1);
    // fewer open visits than the capacity always leaves a free seat within 1..capacity
    expect(pickVisitSeat([open({ visitSeat: 2 })], 2)).toBe(1);
  });
});

describe('leadRowOf', () => {
  test('is the row with the lowest appointment code', () => {
    const rows = [{ appointmentCode: 'APT-0012' }, { appointmentCode: 'APT-0010' }, { appointmentCode: 'APT-0011' }];
    expect(leadRowOf(rows).appointmentCode).toBe('APT-0010');
  });

  test('compares 4-digit and 8-digit codes by number', () => {
    const rows = [{ appointmentCode: 'APT-00010000' }, { appointmentCode: 'APT-9999' }];
    expect(leadRowOf(rows).appointmentCode).toBe('APT-9999');
  });

  test('a visit of one row, and no rows', () => {
    expect(leadRowOf([{ appointmentCode: 'APT-0001' }]).appointmentCode).toBe('APT-0001');
    expect(leadRowOf([])).toBeNull();
  });
});

describe('holdFields', () => {
  test('the lead row holds the car and the seat, the others only the car', () => {
    expect(holdFields({ lead: true, seat: 2 })).toEqual({ holdsCar: true, visitSeat: 2 });
    expect(holdFields({ lead: false, seat: 2 })).toEqual({ holdsCar: true });
  });
});

describe('RELEASE_HOLDS', () => {
  test('releases the car hold, the visit seat and an old slotSeat', () => {
    expect(RELEASE_HOLDS).toEqual({ holdsCar: 1, visitSeat: 1, slotSeat: 1 });
  });
});
