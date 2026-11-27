/**
 * @file staffAttendanceService.js
 * @description Daily attendance of the sales staff who go on test drives ("điểm danh").
 *
 *   default   every active SALES_STAFF user is at work every day
 *   marking   an ADMIN, or a staff account an ADMIN allowed (`canTakeAttendance`), ticks people
 *             in or out for today or a later day (planned leave included); past days are closed
 *   effect    the test-drive slots of that day hold min(Admin ceiling, people at work) visits,
 *             and the day is re-staffed at once: an upcoming visit whose person is off goes to a
 *             free colleague of its slot; with nobody free it is left without anybody and the staff
 *             list flags it (`needsStaff`) so somebody calls the customer. Visits are never
 *             cancelled here.
 */

import User from '../models/User.js';
import Appointment from '../models/Appointment.js';
import StaffAttendance from '../models/StaffAttendance.js';
import ActivityLog from '../models/ActivityLog.js';
import { ActivityEventType, AppointmentType } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { OPEN_STATUSES } from '../constants/appointmentRules.js';
import { fail } from './appointmentErrors.js';
import { invalid } from './appointmentInput.js';
import { parseDateKey, vnInstant, vnDateKey, formatVnIso } from './appointmentSlotRules.js';
import { findOpenInRange, findOpenInRangeWithCode } from './appointmentQueries.js';
import { groupIntoVisits, visitCodeOf } from './appointmentVisitRules.js';
import {
  SALES_STAFF_FILTER, loadStaffing, pickStaff, visitsPerStaff,
} from './appointmentStaffing.js';

const DAY_MS = 24 * 3600 * 1000;
const idOf = (value) => (value === null || value === undefined ? null : String(value));

/** `[start, end)` of a Vietnam day; 422 when the key is not a real date. */
const dayBounds = (date) => {
  const parts = parseDateKey(date);
  if (!parts) throw invalid('date', 'date must be a valid date (YYYY-MM-DD).');
  const start = vnInstant(parts);
  return { start, end: new Date(start.getTime() + DAY_MS) };
};

/** ADMIN, or a staff account an ADMIN allowed. */
export const canTakeAttendance = ({ isAdmin, user }) => isAdmin || user?.canTakeAttendance === true;

/**
 * The attendance sheet of one day.
 * @returns {Promise<{ date, editable, presentCount, total, staff: object[] }>}
 */
export const getAttendance = async ({ date, now = new Date() }) => {
  const { start, end } = dayBounds(date);
  const [staff, records, dayRows] = await Promise.all([
    User.find(SALES_STAFF_FILTER).select('fullName email canTakeAttendance').sort({ fullName: 1 }).lean(),
    StaffAttendance.find({ date }).lean(),
    findOpenInRange(start, end),
  ]);
  const byUser = new Map(records.map((record) => [idOf(record.user), record]));
  const markerIds = [...new Set(records.map((record) => idOf(record.markedBy)).filter(Boolean))];
  const markers = markerIds.length === 0 ? [] : await User.find({ _id: { $in: markerIds } }).select('fullName').lean();
  const markerName = new Map(markers.map((user) => [idOf(user._id), user.fullName ?? null]));
  const load = visitsPerStaff(dayRows);

  const sheet = staff.map((person) => {
    const record = byUser.get(idOf(person._id));
    return {
      _id: idOf(person._id),
      fullName: person.fullName ?? null,
      email: person.email ?? null,
      present: record ? record.present : true,
      canTakeAttendance: person.canTakeAttendance === true,
      visitsThatDay: load.get(idOf(person._id)) ?? 0,
      markedBy: record?.markedBy ? { _id: idOf(record.markedBy), fullName: markerName.get(idOf(record.markedBy)) ?? null } : null,
      markedAt: record?.markedAt ? record.markedAt.toISOString() : null,
    };
  });
  return {
    date,
    editable: date >= vnDateKey(now),
    presentCount: sheet.filter((person) => person.present).length,
    total: sheet.length,
    staff: sheet,
  };
};

/**
 * Re-staffs the upcoming test-drive visits of one day after its attendance changed.
 * @returns {Promise<{ reassigned: object[], unassigned: object[] }>}
 */
export const restaffDay = async ({ date, userId = null, now = new Date() }) => {
  const staffing = await loadStaffing([date]);
  if (!staffing) return { reassigned: [], unassigned: [] };
  const { start, end } = dayBounds(date);
  const dayRows = (await findOpenInRangeWithCode(start, end)).filter((row) => row.type !== AppointmentType.SERVICE);
  const available = staffing.availableOn(date);
  const upcoming = groupIntoVisits(dayRows)
    .filter((visit) => visit.scheduledAt.getTime() > now.getTime())
    .sort((a, b) => a.scheduledAt - b.scheduledAt);

  const reassigned = [];
  const unassigned = [];
  for (const visit of upcoming) {
    const from = idOf(visit.rows.find((row) => row.assignedTo)?.assignedTo);
    if (staffing.isAvailable(date, from)) continue; // eslint-disable-line no-continue
    const time = visit.scheduledAt.getTime();
    const slotRows = dayRows.filter((row) => new Date(row.scheduledAt).getTime() === time);
    const to = pickStaff({ available, slotRows, dayRows, skipRowIds: visit.rows.map((row) => row._id) });
    const report = { visitCode: visitCodeOf(visit.rows), scheduledAt: formatVnIso(visit.scheduledAt), from, to };
    if (to !== from) {
      // eslint-disable-next-line no-await-in-loop
      await Appointment.updateMany(
        { _id: { $in: visit.rows.map((row) => row._id) }, status: { $in: OPEN_STATUSES }, isActive: true },
        { $set: { assignedTo: to, updatedBy: userId } },
      );
      visit.rows.forEach((row) => { row.assignedTo = to; }); // later visits of the day see it
    }
    (to ? reassigned : unassigned).push(report);
  }
  return { reassigned, unassigned };
};

const audit = (entry) => ActivityLog.log({ targetModel: 'User', ...entry }).catch((error) => {
  console.error('Attendance audit log failed:', error.message);
});

const findSalesStaff = async (staffId) => {
  const person = await User.findOne({ _id: staffId, ...SALES_STAFF_FILTER }).select('fullName').lean();
  if (!person) throw fail(MSG.MSG93);
  return person;
};

/**
 * Ticks one person in (`present: true`) or out for a day, then re-staffs that day.
 * @returns {Promise<{ date, staffId, present, reassigned: object[], unassigned: object[] }>}
 */
export const setPresence = async ({ date, staffId, present, userId, ipAddress = null, now = new Date() }) => {
  dayBounds(date);
  if (date < vnDateKey(now)) throw fail(MSG.MSG92);
  const person = await findSalesStaff(staffId);
  await StaffAttendance.findOneAndUpdate(
    { date, user: staffId },
    { $set: { present, markedBy: userId, markedAt: now } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const result = await restaffDay({ date, userId, now });
  await audit({
    eventType: ActivityEventType.STAFF_ATTENDANCE_MARKED,
    performedBy: userId,
    targetId: staffId,
    summary: `${person.fullName ?? staffId} ${present ? 'at work' : 'off'} on ${date}`,
    metadata: { date, present, reassigned: result.reassigned.length, unassigned: result.unassigned.length },
    ipAddress,
  });
  return { date, staffId: idOf(staffId), present, ...result };
};

/** ADMIN lets a sales staff account take attendance (or takes it away). */
export const setAttendanceKeeper = async ({ staffId, enabled, userId, ipAddress = null }) => {
  const person = await findSalesStaff(staffId);
  await User.updateOne({ _id: staffId }, { $set: { canTakeAttendance: enabled, updatedBy: userId } });
  await audit({
    eventType: ActivityEventType.STAFF_ATTENDANCE_KEEPER_CHANGED,
    performedBy: userId,
    targetId: staffId,
    summary: `${person.fullName ?? staffId} ${enabled ? 'may' : 'may no longer'} take attendance`,
    metadata: { enabled },
    ipAddress,
  });
  return { staffId: idOf(staffId), canTakeAttendance: enabled };
};

export default { canTakeAttendance, getAttendance, restaffDay, setPresence, setAttendanceKeeper };
