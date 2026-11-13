/**
 * @file appointment-slot-time.test.js
 * @description Pure time rules of test-drive booking: Vietnam-time slots, GBR-19
 * window, calendar helpers. No database, no HTTP.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-006, REQ-007, NFR-06; AC-04, AC-05)
 */

import {
  assertBookableTime,
  assertStaffBookableTime,
  staffWindowReason,
  windowReason,
  slotLabelOf,
  isOnSlot,
  slotStartsForDate,
  parseDateKey,
  vnDateKey,
  startOfVnDay,
  formatVnIso,
} from '../src/services/appointmentSlotRules.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const at = (iso) => new Date(iso);
/** 10:00 Vietnam time on 2026-11-10 (= 03:00Z). */
const SLOT_10 = at('2026-11-10T03:00:00Z');

const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
};

describe('slot alignment (REQ-007, AC-05)', () => {
  it.each([
    ['2026-11-10T01:00:00Z', '08:00'],
    ['2026-11-10T03:00:00Z', '10:00'],
    ['2026-11-10T06:00:00Z', '13:00'],
    ['2026-11-10T08:00:00Z', '15:00'],
  ])('%s is the %s slot', (iso, label) => {
    expect(slotLabelOf(at(iso))).toBe(label);
    expect(isOnSlot(at(iso))).toBe(true);
  });

  it.each([
    '2026-11-10T02:00:00Z', // 09:00 VN
    '2026-11-10T03:30:00Z', // 10:30 VN
    '2026-11-10T03:00:30Z', // 10:00:30 VN
    '2026-11-10T03:00:00.500Z', // 10:00:00.5 VN
    '2026-11-10T10:00:00Z', // 17:00 VN
  ])('%s is not a slot', (iso) => {
    expect(isOnSlot(at(iso))).toBe(false);
  });

  it('the same instant written with an offset is still the 10:00 slot', () => {
    expect(isOnSlot(at('2026-11-10T10:00:00+07:00'))).toBe(true);
  });

  it('reads a UTC time as the next Vietnam day around midnight', () => {
    expect(vnDateKey(at('2026-11-10T16:59:00Z'))).toBe('2026-11-10'); // 23:59 VN
    expect(vnDateKey(at('2026-11-10T17:00:00Z'))).toBe('2026-11-11'); // 00:00 VN
    expect(isOnSlot(at('2026-11-10T17:00:00Z'))).toBe(false);
  });
});

describe('booking window (REQ-006, AC-04)', () => {
  const now = new Date(SLOT_10.getTime() - 30 * HOUR);

  it('accepts a slot well inside the window', () => {
    expect(() => assertBookableTime(SLOT_10, now)).not.toThrow();
  });

  it('accepts exactly 2 hours ahead and rejects 1 ms less', () => {
    expect(windowReason(SLOT_10, new Date(SLOT_10.getTime() - 2 * HOUR))).toBeNull();
    expect(windowReason(SLOT_10, new Date(SLOT_10.getTime() - 2 * HOUR + 1))).toBe('TOO_SOON');
  });

  it('accepts exactly 60 days ahead and rejects 1 ms more', () => {
    expect(windowReason(SLOT_10, new Date(SLOT_10.getTime() - 60 * DAY))).toBeNull();
    expect(windowReason(SLOT_10, new Date(SLOT_10.getTime() - 60 * DAY - 1))).toBe('TOO_FAR');
  });

  it('reports APPOINTMENT_TOO_SOON / APPOINTMENT_TOO_FAR with the existing messages', () => {
    const soon = new Date(SLOT_10.getTime() - HOUR);
    const far = new Date(SLOT_10.getTime() - 61 * DAY);
    expect(codeOf(() => assertBookableTime(SLOT_10, soon))).toBe('APPOINTMENT_TOO_SOON');
    expect(codeOf(() => assertBookableTime(SLOT_10, far))).toBe('APPOINTMENT_TOO_FAR');
  });

  it('checks the window before the slot, so "1 hour from now" is TOO_SOON, not SLOT_INVALID', () => {
    const odd = at('2026-11-10T00:30:00Z');
    const nowNear = new Date(odd.getTime() - HOUR);
    expect(codeOf(() => assertBookableTime(odd, nowNear))).toBe('APPOINTMENT_TOO_SOON');
  });

  it('rejects an off-slot time inside the window with APPOINTMENT_SLOT_INVALID', () => {
    expect(codeOf(() => assertBookableTime(at('2026-11-10T02:00:00Z'), now))).toBe('APPOINTMENT_SLOT_INVALID');
    expect(codeOf(() => assertBookableTime(at('2026-11-10T10:00:00Z'), now))).toBe('APPOINTMENT_SLOT_INVALID');
  });
});

describe('calendar helpers', () => {
  it('parses real dates and rejects impossible or malformed ones', () => {
    expect(parseDateKey('2026-11-10')).toEqual({ year: 2026, month: 11, day: 10 });
    expect(parseDateKey('2026-02-30')).toBeNull();
    expect(parseDateKey('2026-1-1')).toBeNull();
    expect(parseDateKey('not-a-date')).toBeNull();
  });

  it('lists the four slot instants of a day in UTC', () => {
    expect(slotStartsForDate('2026-11-10').map((d) => d.toISOString())).toEqual([
      '2026-11-10T01:00:00.000Z',
      '2026-11-10T03:00:00.000Z',
      '2026-11-10T06:00:00.000Z',
      '2026-11-10T08:00:00.000Z',
    ]);
    expect(slotStartsForDate('2026-02-30')).toEqual([]);
  });

  it('formats a slot with the +07:00 offset the API contract uses', () => {
    expect(formatVnIso(SLOT_10)).toBe('2026-11-10T10:00:00+07:00');
  });

  it('finds 00:00 Vietnam time of the containing day', () => {
    expect(startOfVnDay(at('2026-11-10T20:00:00Z')).toISOString()).toBe('2026-11-10T17:00:00.000Z');
    expect(startOfVnDay(at('2026-11-10T05:00:00Z')).toISOString()).toBe('2026-11-09T17:00:00.000Z');
  });
});

// ── 1.1.0: staff window (REQ-034, REQ-039; AC-33, AC-37) ─────────────────────
describe('staff window: no 2-hour lead time, but still in the future and within 60 days', () => {
  const SLOT_13 = at('2026-11-10T06:00:00Z'); // 13:00 VN

  it('accepts a slot that starts 15 minutes from now (a customer could not book it)', () => {
    const now = new Date(SLOT_13.getTime() - 15 * 60 * 1000);
    expect(codeOf(() => assertBookableTime(SLOT_13, now))).toBe('APPOINTMENT_TOO_SOON');
    expect(codeOf(() => assertStaffBookableTime(SLOT_13, now))).toBeNull();
    expect(staffWindowReason(SLOT_13, now)).toBeNull();
  });

  it('rejects a slot that already started or starts exactly now (MSG35)', () => {
    expect(staffWindowReason(SLOT_13, SLOT_13)).toBe('PAST');
    expect(codeOf(() => assertStaffBookableTime(SLOT_13, SLOT_13))).toBe('APPOINTMENT_TOO_SOON');
    expect(codeOf(() => assertStaffBookableTime(SLOT_13, new Date(SLOT_13.getTime() + 1000)))).toBe('APPOINTMENT_TOO_SOON');
  });

  it('still allows exactly 60 days and rejects beyond (MSG36)', () => {
    const slot = at('2026-11-10T03:00:00Z');
    expect(codeOf(() => assertStaffBookableTime(slot, new Date(slot.getTime() - 60 * DAY)))).toBeNull();
    expect(staffWindowReason(slot, new Date(slot.getTime() - 60 * DAY - 1))).toBe('TOO_FAR');
    expect(codeOf(() => assertStaffBookableTime(slot, new Date(slot.getTime() - 61 * DAY)))).toBe('APPOINTMENT_TOO_FAR');
  });

  it('the slot grid still applies (MSG79), and the window is checked before it', () => {
    const now = at('2026-11-08T00:00:00Z');
    expect(codeOf(() => assertStaffBookableTime(at('2026-11-10T03:30:00Z'), now))).toBe('APPOINTMENT_SLOT_INVALID');
    expect(codeOf(() => assertStaffBookableTime(at('2026-11-07T03:30:00Z'), now))).toBe('APPOINTMENT_TOO_SOON');
  });
});
