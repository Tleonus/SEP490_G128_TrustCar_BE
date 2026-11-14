/**
 * @file test-drive-slots.test.js
 * @description Slot generation and the booking window, independent of the
 * server's timezone. Dates: 2026-11-09 is a Monday, 2026-11-08 a Sunday,
 * 2026-11-14 a Saturday.
 */

import { getDefaultBaseSettings } from '../src/config/baseSettings.js';
import {
  addLocalDays, findSlotByStart, generateSlots, isWithinBookingWindow, overlaps, toLocalDate, toLocalIso,
} from '../src/services/testDriveSlots.js';

const settings = (testDrive = {}, change = () => {}) => {
  const value = getDefaultBaseSettings();
  value.testDrive = { ...value.testDrive, ...testDrive };
  change(value);
  return value;
};

const startTimes = (slots) => slots.map((slot) => toLocalIso(slot.startAt).slice(11, 16));

describe('generateSlots', () => {
  test('defaults give 7 slots around the lunch break', () => {
    const slots = generateSlots('2026-11-09', settings());
    expect(startTimes(slots)).toEqual(['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00']);
    expect(toLocalIso(slots[0].startAt)).toBe('2026-11-09T09:00:00+07:00');
    expect(toLocalIso(slots[0].endAt)).toBe('2026-11-09T10:00:00+07:00');
  });

  test('a closed Sunday has no slots until the showroom opens on Sundays', () => {
    expect(generateSlots('2026-11-08', settings())).toEqual([]);

    const openSunday = settings({}, (value) => {
      value.businessHours.weeklySchedule[0] = { dayOfWeek: 0, label: 'Chủ nhật', isOpen: true, openTime: '08:00', closeTime: '20:00' };
    });
    expect(generateSlots('2026-11-08', openSunday)).toHaveLength(7);
  });

  test('a holiday has no slots, whether stored as a date or a full timestamp', () => {
    expect(generateSlots('2026-11-09', settings({}, (value) => { value.businessHours.holidays = ['2026-11-09']; }))).toEqual([]);
    expect(generateSlots('2026-11-09', settings({}, (value) => { value.businessHours.holidays = ['2026-11-09T00:00:00.000Z']; }))).toEqual([]);
  });

  test('a holiday sent as local midnight in UTC closes the Vietnam date, not the day before', () => {
    const holiday = settings({}, (value) => { value.businessHours.holidays = ['2026-11-09T17:00:00.000Z']; }); // 00:00 on the 10th in Vietnam
    expect(generateSlots('2026-11-10', holiday)).toEqual([]);
    expect(generateSlots('2026-11-09', holiday)).toHaveLength(7);
  });

  test('no slot ends after an earlier showroom closing time', () => {
    const earlySaturday = settings({}, (value) => { value.businessHours.weeklySchedule[6].closeTime = '15:00'; });
    expect(startTimes(generateSlots('2026-11-14', earlySaturday))).toEqual(['09:00', '10:00', '11:00', '13:00', '14:00']);
  });

  test.each([
    ['10:00', ['10:00', '11:00', '13:00', '14:00', '15:00', '16:00']],
    ['09:30', ['10:00', '11:00', '13:00', '14:00', '15:00', '16:00']],
    ['13:30', ['14:00', '15:00', '16:00']],
  ])('opening at %s drops earlier slots and keeps the others at their usual times', (openTime, expected) => {
    const lateOpening = settings({}, (value) => { value.businessHours.weeklySchedule[1].openTime = openTime; });
    expect(startTimes(generateSlots('2026-11-09', lateOpening))).toEqual(expected);
  });

  test('45-minute slots drop leftover time and restart at the end of lunch', () => {
    const times = startTimes(generateSlots('2026-11-09', settings({ slotDurationMinutes: 45 })));
    expect(times).toEqual(['09:00', '09:45', '10:30', '11:15', '13:00', '13:45', '14:30', '15:15', '16:00']);
  });

  test('a slot that would run into lunch is not offered', () => {
    const times = startTimes(generateSlots('2026-11-09', settings({ slotDurationMinutes: 90 })));
    expect(times).toEqual(['09:00', '10:30', '13:00', '14:30']);
  });
});

describe('isWithinBookingWindow', () => {
  const now = new Date('2026-11-09T00:30:00.000Z'); // 07:30 in Vietnam

  test('needs at least 2 hours of notice', () => {
    expect(isWithinBookingWindow(new Date('2026-11-09T02:00:00.000Z'), now)).toBe(false); // 09:00 local
    expect(isWithinBookingWindow(new Date('2026-11-09T02:30:00.000Z'), now)).toBe(true);
    expect(isWithinBookingWindow(new Date('2026-11-09T03:00:00.000Z'), now)).toBe(true);  // 10:00 local
  });

  test('allows at most 60 days ahead', () => {
    const limit = now.getTime() + 60 * 24 * 60 * 60 * 1000;
    expect(isWithinBookingWindow(new Date(limit), now)).toBe(true);
    expect(isWithinBookingWindow(new Date(limit + 1), now)).toBe(false);
  });
});

describe('helpers', () => {
  test('overlaps treats touching ranges as free', () => {
    expect(overlaps(1, 2, 2, 3)).toBe(false);
    expect(overlaps(1, 3, 2, 4)).toBe(true);
  });

  test('findSlotByStart matches only an exact slot start', () => {
    const slots = generateSlots('2026-11-09', settings());
    expect(findSlotByStart(slots, new Date('2026-11-09T02:00:00.000Z'))).toBe(slots[0]);
    expect(findSlotByStart(slots, new Date('2026-11-09T02:30:00.000Z'))).toBeNull();
  });

  test('local dates follow Vietnam time, not UTC', () => {
    expect(toLocalDate(new Date('2026-11-08T17:30:00.000Z'))).toBe('2026-11-09');
    expect(addLocalDays('2026-11-30', 1)).toBe('2026-12-01');
  });
});
