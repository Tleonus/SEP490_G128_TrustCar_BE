/**
 * @file testDriveSlots.js
 * @description Pure time-slot logic for test-drive booking. Slots are derived
 * from the showroom settings and never stored, so changing the settings needs
 * no data change. All local times are Asia/Ho_Chi_Minh, whatever the server's
 * own timezone is.
 *
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-005
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-006
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-008
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-013
 */

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { SETTINGS_TIMEZONE } from '../config/baseSettings.js';
import { APPOINTMENT_CONSTRAINTS } from '../constants/appConstants.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const toMinutes = (hhmm) => {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
};

const toTimeText = (totalMinutes) => {
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
};

const atLocalTime = (date, totalMinutes) =>
  dayjs.tz(`${date} ${toTimeText(totalMinutes)}`, 'YYYY-MM-DD HH:mm', SETTINGS_TIMEZONE).toDate();

/** Half-open ranges: a slot ending when another starts does not overlap it. */
export const overlaps = (startA, endA, startB, endB) => startA < endB && startB < endA;

/** Local calendar date (YYYY-MM-DD) of an instant. */
export const toLocalDate = (instant) => dayjs(instant).tz(SETTINGS_TIMEZONE).format('YYYY-MM-DD');

/** Formats an instant as ISO 8601 with the showroom's offset. */
export const toLocalIso = (instant) => dayjs(instant).tz(SETTINGS_TIMEZONE).format();

/** Shifts a local calendar date by whole days. */
export const addLocalDays = (date, days) =>
  dayjs.tz(`${date} 12:00`, 'YYYY-MM-DD HH:mm', SETTINGS_TIMEZONE).add(days, 'day').format('YYYY-MM-DD');

/** Start (inclusive) and end (exclusive) instants of a local calendar date. */
export const localDayRange = (date) => ({
  start: dayjs.tz(`${date} 00:00`, 'YYYY-MM-DD HH:mm', SETTINGS_TIMEZONE).toDate(),
  end: dayjs.tz(`${addLocalDays(date, 1)} 00:00`, 'YYYY-MM-DD HH:mm', SETTINGS_TIMEZONE).toDate(),
});

/**
 * Generates a day's slots. A slot touching the lunch break moves the next slot
 * to the end of the break; a slot before the day's opening time, or time left over
 * that cannot fit a slot, is dropped.
 *
 * @param {string} date - Local date, YYYY-MM-DD.
 * @param {object} settings - Showroom settings (businessHours, testDrive).
 * @returns {Array<{startAt: Date, endAt: Date}>} empty when the showroom is closed.
 */
export const generateSlots = (date, { businessHours, testDrive }) => {
  // Holidays may arrive as a timestamp in UTC, so compare them as Vietnam dates.
  const isHoliday = businessHours.holidays.some((holiday) => toLocalDate(new Date(holiday)) === date);
  const dayOfWeek = dayjs.tz(`${date} 12:00`, 'YYYY-MM-DD HH:mm', SETTINGS_TIMEZONE).day();
  const day = businessHours.weeklySchedule.find((entry) => entry.dayOfWeek === dayOfWeek);
  if (isHoliday || !day?.isOpen) return [];

  const duration = testDrive.slotDurationMinutes;
  const lunchStart = toMinutes(testDrive.lunchBreakStart);
  const lunchEnd = toMinutes(testDrive.lunchBreakEnd);
  const lastEnd = Math.min(toMinutes(testDrive.closeTime), toMinutes(day.closeTime));
  const dayOpen = toMinutes(day.openTime);

  const slots = [];
  let start = toMinutes(testDrive.openTime);
  while (start + duration <= lastEnd) {
    if (overlaps(start, start + duration, lunchStart, lunchEnd)) {
      start = lunchEnd;
    } else {
      // Slots before opening are skipped, not shifted, so the others keep their usual times.
      if (start >= dayOpen) slots.push({ startAt: atLocalTime(date, start), endAt: atLocalTime(date, start + duration) });
      start += duration;
    }
  }
  return slots;
};

/** GBR-19: at least 2 hours ahead and at most 60 days ahead. */
export const isWithinBookingWindow = (startAt, now = new Date()) => {
  const lead = startAt.getTime() - now.getTime();
  return lead >= APPOINTMENT_CONSTRAINTS.MIN_HOURS_AHEAD * MS_PER_HOUR
    && lead <= APPOINTMENT_CONSTRAINTS.MAX_DAYS_AHEAD * MS_PER_DAY;
};

/** Finds the slot starting exactly at an instant, if any. */
export const findSlotByStart = (slots, instant) =>
  slots.find((slot) => slot.startAt.getTime() === instant.getTime()) || null;

export default { generateSlots, overlaps, isWithinBookingWindow, findSlotByStart, toLocalDate, toLocalIso, addLocalDays, localDayRange };
