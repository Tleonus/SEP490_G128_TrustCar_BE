/**
 * @file appointmentAssigneeService.js
 * @description The staff member who goes on a test drive with the customer ("người phụ trách").
 *
 *   options   who can take a visit: sales staff at work that day, each with whether they are busy
 *             with another visit of the same slot and how many visits they have that day
 *   reassign  staff/admin move a visit to another person at work and free in its slot
 *   confirm   a visit confirmed without anybody assigned gets the confirming staff member when
 *             free, else a free colleague (appointmentStaffing.js)
 *
 * Every open appointment of the visit carries the same `assignedTo`.
 */

import Appointment from '../models/Appointment.js';
import ActivityLog from '../models/ActivityLog.js';
import { ActivityEventType } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { OPEN_STATUSES } from '../constants/appointmentRules.js';
import { fail } from './appointmentErrors.js';
import { vnDateKey, formatVnIso } from './appointmentSlotRules.js';
import { findOpenAtSlot, findVisitRowsByAnyId } from './appointmentQueries.js';
import { groupIntoVisits, isOpenRow, visitCodeOf, visitContaining } from './appointmentVisitRules.js';
import {
  busyAt, chooseAssignee, findOpenOnDay, loadStaffing, visitsPerStaff,
} from './appointmentStaffing.js';

const idOf = (value) => (value === null || value === undefined ? null : String(value));
const assigneeOf = (rows) => idOf(rows.find((row) => row.assignedTo)?.assignedTo);

const loadVisit = async (id) => {
  const rows = await findVisitRowsByAnyId(id);
  if (rows.length === 0) throw fail(MSG.MSG38);
  return visitContaining(groupIntoVisits(rows), id);
};

/** Open and not started yet: only then can its person change. */
const isReassignable = (open, scheduledAt, now) => open.length > 0 && scheduledAt.getTime() > now.getTime();

/**
 * Who can take the visit `id`.
 * @returns {Promise<{ visitId: string, scheduledAt: string, editable: boolean, current: string|null,
 *   options: Array<{ _id: string, fullName: string|null, busy: boolean, visitsThatDay: number, current: boolean }> }>}
 */
export const listAssigneeOptions = async ({ id, now = new Date() }) => {
  const visit = await loadVisit(id);
  const open = visit.rows.filter(isOpenRow);
  const dateKey = vnDateKey(visit.scheduledAt);
  const [staffing, slotRows, dayRows] = await Promise.all([
    loadStaffing([dateKey]), findOpenAtSlot(visit.scheduledAt), findOpenOnDay(visit.scheduledAt),
  ]);
  const skip = new Set(open.map((row) => idOf(row._id)));
  const busy = busyAt(slotRows, skip);
  const load = visitsPerStaff(dayRows, skip);
  const current = assigneeOf(open);
  return {
    visitId: visit.visitId,
    scheduledAt: formatVnIso(visit.scheduledAt),
    editable: isReassignable(open, visit.scheduledAt, now),
    current,
    options: (staffing?.availableOn(dateKey) ?? []).map((person) => {
      const personId = idOf(person._id);
      return {
        _id: personId,
        fullName: person.fullName ?? null,
        busy: busy.has(personId),
        visitsThatDay: load.get(personId) ?? 0,
        current: personId === current,
      };
    }),
  };
};

const logReassigned = async (rows, { from, to, userId, ipAddress }) => {
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await ActivityLog.log({
        eventType: ActivityEventType.APPOINTMENT_REASSIGNED,
        performedBy: userId ?? null,
        targetModel: 'Appointment',
        targetId: row._id,
        targetCode: row.appointmentCode,
        changes: { before: { assignedTo: from }, after: { assignedTo: to } },
        summary: `Test-drive staff ${from ?? 'none'} → ${to}`,
        ipAddress: ipAddress ?? null,
      });
    } catch (error) {
      console.error('Appointment audit log failed:', error.message);
    }
  }
};

/**
 * Gives the visit `id` to `staffId`: a sales staff member at work that day, not busy with
 * another visit of the slot. Returns the visit code.
 */
export const reassignVisit = async ({ id, staffId, userId, ipAddress, now = new Date() }) => {
  const visit = await loadVisit(id);
  const open = visit.rows.filter(isOpenRow);
  if (!isReassignable(open, visit.scheduledAt, now)) throw fail(MSG.MSG95);

  const dateKey = vnDateKey(visit.scheduledAt);
  const staffing = await loadStaffing([dateKey]);
  if (!staffing?.isAvailable(dateKey, staffId)) throw fail(MSG.MSG90);
  const skip = new Set(open.map((row) => idOf(row._id)));
  if (busyAt(await findOpenAtSlot(visit.scheduledAt), skip).has(idOf(staffId))) throw fail(MSG.MSG91);

  const from = assigneeOf(open);
  if (from === idOf(staffId)) return visitCodeOf(visit.rows);
  const update = await Appointment.updateMany(
    { _id: { $in: open.map((row) => row._id) }, status: { $in: OPEN_STATUSES }, isActive: true },
    { $set: { assignedTo: staffId, updatedBy: userId } },
  );
  if (update.modifiedCount === 0) throw fail(MSG.MSG81); // changed by somebody else meanwhile
  await logReassigned(open, { from, to: idOf(staffId), userId, ipAddress });
  return visitCodeOf(visit.rows);
};

/**
 * After a confirmation: rows without anybody get the visit's person, or a free one (the
 * confirming staff member first). Nobody free → left empty, the list flags it (`needsStaff`).
 */
export const assignOnConfirm = async ({ visit, open, prefer }) => {
  const missing = open.filter((row) => !row.assignedTo);
  if (missing.length === 0) return;
  let person = assigneeOf(open);
  if (!person) {
    const staffing = await loadStaffing([vnDateKey(visit.scheduledAt)]);
    const slotRows = staffing ? await findOpenAtSlot(visit.scheduledAt) : [];
    person = await chooseAssignee({
      staffing, scheduledAt: visit.scheduledAt, slotRows, prefer, skipRowIds: open.map((row) => row._id),
    });
  }
  if (!person) return;
  await Appointment.updateMany({ _id: { $in: missing.map((row) => row._id) }, assignedTo: null }, { $set: { assignedTo: person } });
};

export default { listAssigneeOptions, reassignVisit, assignOnConfirm };
