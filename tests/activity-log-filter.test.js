/**
 * @file activity-log-filter.test.js
 * @description KAN-40: the pure filter builder of the activity-log list (Vietnam-day range,
 * literal e-mail matching, ObjectId, sort direction).
 *
 * Ref: .sdd/features/system-audit-logs/SPEC.md (REQ-004, REQ-006; AC-03…07, AC-10)
 */

import mongoose from 'mongoose';
import { buildFilter, dayRange, escapeRegex, sortDirection } from '../src/services/activityLogFilter.js';

const inRange = (iso, range) => {
  const t = new Date(iso).getTime();
  return (range.$gte === undefined || t >= range.$gte.getTime()) && (range.$lt === undefined || t < range.$lt.getTime());
};

describe('dayRange: Vietnam days, "to" inclusive', () => {
  test('one day is 00:00 VN to 00:00 VN the next day', () => {
    const range = dayRange('2026-11-15', '2026-11-15');
    expect(range.$gte.toISOString()).toBe('2026-11-14T17:00:00.000Z');
    expect(range.$lt.toISOString()).toBe('2026-11-15T17:00:00.000Z');
  });

  test('00:30 VN on the 15th (= 17:30Z on the 14th) belongs to the 15th, not the 14th', () => {
    expect(inRange('2026-11-14T17:30:00Z', dayRange('2026-11-15', '2026-11-15'))).toBe(true);
    expect(inRange('2026-11-14T17:30:00Z', dayRange('2026-11-14', '2026-11-14'))).toBe(false);
  });

  test('23:59:59.999 VN is still inside the day, 00:00:00.000 VN next day is outside', () => {
    const range = dayRange('2026-11-15', '2026-11-15');
    expect(inRange('2026-11-15T16:59:59.999Z', range)).toBe(true);
    expect(inRange('2026-11-15T17:00:00.000Z', range)).toBe(false);
    expect(inRange('2026-11-14T16:59:59.999Z', range)).toBe(false);
    expect(inRange('2026-11-14T17:00:00.000Z', range)).toBe(true);
  });

  test('a multi-day range includes both end days entirely', () => {
    const range = dayRange('2026-11-10', '2026-11-12');
    expect(inRange('2026-11-09T17:00:00Z', range)).toBe(true);
    expect(inRange('2026-11-12T16:59:00Z', range)).toBe(true);
    expect(inRange('2026-11-12T17:00:00Z', range)).toBe(false);
  });

  test('only "from" or only "to" gives a half-open range; none gives an empty object', () => {
    expect(Object.keys(dayRange('2026-11-15'))).toEqual(['$gte']);
    expect(Object.keys(dayRange(undefined, '2026-11-15'))).toEqual(['$lt']);
    expect(dayRange()).toEqual({});
  });

  test('crosses a month and a year boundary correctly', () => {
    expect(dayRange('2026-12-31', '2026-12-31').$lt.toISOString()).toBe('2026-12-31T17:00:00.000Z');
    expect(dayRange('2026-02-28', '2026-02-28').$lt.toISOString()).toBe('2026-02-28T17:00:00.000Z');
  });

  test('a date that does not exist is ignored instead of throwing', () => {
    expect(dayRange('2026-02-30', 'nonsense')).toEqual({});
  });
});

describe('buildFilter', () => {
  test('no query gives an empty filter', () => {
    expect(buildFilter()).toEqual({});
    expect(buildFilter({})).toEqual({});
  });

  test('plain equality filters', () => {
    expect(buildFilter({ eventType: 'CAR_PRICE_UPDATED', targetModel: 'Car', targetCode: 'TC-2026-0001' }))
      .toEqual({ eventType: 'CAR_PRICE_UPDATED', targetModel: 'Car', targetCode: 'TC-2026-0001' });
  });

  test('targetId becomes an ObjectId', () => {
    const id = String(new mongoose.Types.ObjectId());
    const { targetId } = buildFilter({ targetId: id });
    expect(targetId).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(targetId)).toBe(id);
  });

  test('all filters combine into one object (AND)', () => {
    const filter = buildFilter({ eventType: 'USER_LOGIN', actorEmail: 'admin@trustcar.vn', from: '2026-11-01', to: '2026-11-30' });
    expect(Object.keys(filter).sort()).toEqual(['createdAt', 'eventType', 'performedByEmail']);
    expect(filter.createdAt.$gte).toBeInstanceOf(Date);
  });

  test('values that are absent are not added', () => {
    expect(buildFilter({ eventType: undefined, actorEmail: '', from: undefined })).toEqual({});
  });
});

describe('actorEmail: whole string, case-insensitive, literal', () => {
  const matches = (needle, stored) => buildFilter({ actorEmail: needle }).performedByEmail.test(stored);

  test('ignores case on both sides', () => {
    expect(matches('ADMIN@TrustCar.vn', 'admin@trustcar.vn')).toBe(true);
    expect(matches('admin@trustcar.vn', 'Admin@TRUSTCAR.vn')).toBe(true);
  });

  test('is not a partial match', () => {
    expect(matches('admin@', 'admin@trustcar.vn')).toBe(false);
    expect(matches('trustcar.vn', 'admin@trustcar.vn')).toBe(false);
    expect(matches('admin@trustcar.vn', 'xadmin@trustcar.vn')).toBe(false);
    expect(matches('admin@trustcar.vn', 'admin@trustcar.vn.evil.com')).toBe(false);
  });

  test('regex characters are matched literally (a.b+c@x.vn)', () => {
    expect(matches('a.b+c@x.vn', 'a.b+c@x.vn')).toBe(true);
    expect(matches('a.b+c@x.vn', 'aXb+c@x.vn')).toBe(false);
    expect(matches('a.b+c@x.vn', 'abbc@x.vn')).toBe(false);
  });

  test.each([['.*'], ['(a+)+'], ['['], ['\\'], ['^$'], ['a|b'], ['{1,}']])('%s is a plain string, not a pattern', (text) => {
    expect(matches(text, text)).toBe(true);
    expect(matches(text, `x${text}`)).toBe(false);
    expect(matches(text, 'admin@trustcar.vn')).toBe(false);
  });

  test('a catastrophic-looking input still runs instantly', () => {
    const evil = `${'a'.repeat(5000)}!`;
    const started = Date.now();
    matches('(a+)+$', evil);
    expect(Date.now() - started).toBeLessThan(200);
  });

  test('surrounding whitespace is ignored', () => {
    expect(matches('  admin@trustcar.vn  ', 'admin@trustcar.vn')).toBe(true);
  });

  test('escapeRegex leaves ordinary text alone and escapes every metacharacter', () => {
    expect(escapeRegex('abc 123 @-_')).toBe('abc 123 @-_');
    expect(escapeRegex('.*+?^${}()|[]\\')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
  });
});

describe('sortDirection', () => {
  test('newest first by default and for desc, oldest first for asc', () => {
    expect(sortDirection()).toBe(-1);
    expect(sortDirection({})).toBe(-1);
    expect(sortDirection({ sort: 'desc' })).toBe(-1);
    expect(sortDirection({ sort: 'asc' })).toBe(1);
  });
});
