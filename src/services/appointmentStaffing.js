/**
 * @file appointmentStaffing.js
 * @description Who can go on a test drive with a customer, and who gets a visit.
 *
 *   staff      every active user holding SALES_STAFF
 *   at work    present every day by default; an attendance record `present: false`
 *              (StaffAttendance) takes them out for that Vietnam day
 *   one visit  = one staff member: an open visit (PENDING or CONFIRMED) keeps the person it is
 *              assigned to busy for its slot. A slot therefore holds at most
 *              min(Admin `maxGuestsPerSlot`, staff at work that day) visits; when every person is
 *              taken the slot is full for customers and staff alike.
 *   picking    a new or moved visit gets a free person of its slot: the preferred one when free
 *              (the staff member booking or confirming it, or its previous person when it moves),
 *              else the one with the fewest open visits that day.
 *
 * Pure helpers + two reads. Visits written before this existed may have nobody (or an ADMIN)
 * assigned: they still take a place in their slot and are flagged `needsStaff` for staff.
 */

import User from '../models/User.js';
import StaffAttendance from '../models/StaffAttendance.js';
import { AppointmentType, Roles } from '../constants/appConstants.js';
import { OPEN_STATUSES } from '../constants/appointmentRules.js';
import { vnDateKey, startOfVnDay } from './appointmentSlotRules.js';
import { findOpenInRange } from './appointmentQueries.js';

const DAY_MS = 24 * 3600 * 1000;
const idOf = (value) => (value === null || value === undefined ? null : String(value));
const isOpen = (row) => OPEN_STATUSES.includes(row.status) && row.isActive !== false;
const visitKey = (row) => `${idOf(row.customer)}|${new Date(row.scheduledAt).getTime()}`;

/** Sales staff filter (accounts from before multi-role only have `roleName`). */
export const SALES_STAFF_FILTER = Object.freeze({
  isActive: true,
  $or: [{ roleNames: Roles.SALES_STAFF }, { roleName: Roles.SALES_STAFF }],
});

const loadFromDatabase = async (dateKeys) => {
  const [staff, absences] = await Promise.all([
    User.find(SALES_STAFF_FILTER).select('fullName email canTakeAttendance').sort({ fullName: 1 }).lean(),
    dateKeys.length === 0 ? [] : StaffAttendance.find({ date: { $in: dateKeys }, present: false }).select('date user').lean(),
  ]);
  return { staff, absences };
};

let directory = loadFromDatabase;

/**
 * Replaces where staff and absences come from (tests). `null` restores the database. A source
 * that resolves to `null` turns staffing off: only the Admin capacity applies and nobody is
 * picked automatically (the behaviour from before this feature).
 */
export const setStaffDirectory = (source) => { directory = source ?? loadFromDatabase; };

/**
 * Pure: staffing of some days from the staff list and the absence records.
 * @param {{ staff: object[], absences?: Array<{ date: string, user: * }> }} data
 */
export const buildStaffing = ({ staff, absences = [] }) => {
  const absent = new Map();
  absences.forEach(({ date, user }) => {
    if (!absent.has(date)) absent.set(date, new Set());
    absent.get(date).add(idOf(user));
  });
  const availableOn = (dateKey) => staff.filter((person) => !absent.get(dateKey)?.has(idOf(person._id)));
  const isAvailable = (dateKey, userId) =>
    userId !== null && userId !== undefined && availableOn(dateKey).some((person) => idOf(person._id) === idOf(userId));
  return { staff, availableOn, isAvailable };
};

/** Staffing of the given Vietnam days, or `null` when staffing is off (tests). */
export const loadStaffing = async (dateKeys) => {
  const data = await directory([...new Set(dateKeys)]);
  return data ? buildStaffing(data) : null;
};

/** Visits one slot of `dateKey` can hold. */
export const capacityOn = (staffing, dateKey, maxGuests) =>
  (staffing ? Math.min(maxGuests, staffing.availableOn(dateKey).length) : maxGuests);

/** Ids of the people already handling another open visit in this slot. */
export const busyAt = (slotRows, skip = new Set()) => new Set(slotRows
  .filter((row) => isOpen(row) && !skip.has(idOf(row._id)))
  .map((row) => idOf(row.assignedTo))
  .filter(Boolean));

/** Open visits per person on one day (rows in `skip` do not count). */
export const visitsPerStaff = (dayRows, skip = new Set()) => {
  const visits = new Map();
  dayRows.filter((row) => isOpen(row) && row.assignedTo && !skip.has(idOf(row._id))).forEach((row) => {
    const person = idOf(row.assignedTo);
    if (!visits.has(person)) visits.set(person, new Set());
    visits.get(person).add(visitKey(row));
  });
  return new Map([...visits].map(([person, keys]) => [person, keys.size]));
};

/**
 * Pure: the person a visit should get, or null when nobody at work is free in the slot.
 * @param {object} p
 * @param {object[]} p.available   Staff at work that day (`availableOn`).
 * @param {object[]} p.slotRows    Open rows of the slot.
 * @param {object[]} [p.dayRows]   Open rows of the whole day (balances the load).
 * @param {*} [p.prefer]           Taken when free.
 * @param {Array} [p.skipRowIds]   Rows of the visit itself (when it moves or is confirmed).
 * @returns {string|null}
 */
export const pickStaff = ({ available, slotRows, dayRows = [], prefer = null, skipRowIds = [] }) => {
  const skip = new Set(skipRowIds.map(idOf));
  const busy = busyAt(slotRows, skip);
  const free = available.filter((person) => !busy.has(idOf(person._id)));
  if (prefer && free.some((person) => idOf(person._id) === idOf(prefer))) return idOf(prefer);
  const load = visitsPerStaff(dayRows, skip);
  const loadOf = (person) => load.get(idOf(person._id)) ?? 0;
  const [first] = [...free].sort((a, b) => loadOf(a) - loadOf(b)
    || String(a.fullName ?? '').localeCompare(String(b.fullName ?? ''), 'vi')
    || idOf(a._id).localeCompare(idOf(b._id)));
  return first ? idOf(first._id) : null;
};

/** Open rows of the Vietnam day of `instant`. Inside a transaction pass its `session`. */
export const findOpenOnDay = (instant, { session = null } = {}) => {
  const start = startOfVnDay(instant);
  return findOpenInRange(start, new Date(start.getTime() + DAY_MS), { session });
};

/**
 * The person for a visit at `scheduledAt` (reads the day's rows). With staffing off: `prefer`.
 * @returns {Promise<string|null>}
 */
export const chooseAssignee = async ({ staffing, scheduledAt, slotRows, prefer = null, skipRowIds = [], session = null }) => {
  if (!staffing) return prefer ? idOf(prefer) : null;
  const dayRows = await findOpenOnDay(scheduledAt, { session });
  return pickStaff({ available: staffing.availableOn(vnDateKey(scheduledAt)), slotRows, dayRows, prefer, skipRowIds });
};

/**
 * Staff flag: an open test-drive visit that has not started and has nobody at work assigned
 * (never assigned, assigned to someone off that day, or to someone who is not sales staff).
 */
export const needsStaff = (visit, staffing, now = new Date()) => {
  if (!staffing) return false;
  const open = visit.rows.filter(isOpen);
  if (open.length === 0 || open.some((row) => row.type === AppointmentType.SERVICE)) return false;
  const at = new Date(visit.scheduledAt);
  if (at.getTime() <= now.getTime()) return false;
  const person = open.find((row) => row.assignedTo)?.assignedTo ?? null;
  return !staffing.isAvailable(vnDateKey(at), person);
};

export default {
  setStaffDirectory, buildStaffing, loadStaffing, capacityOn, busyAt, visitsPerStaff, pickStaff,
  findOpenOnDay, chooseAssignee, needsStaff,
};
