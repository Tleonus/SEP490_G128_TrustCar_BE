/**
 * @file appointmentCustomerService.js
 * @description What a logged-in customer can do with their own visits: list, read, cancel.
 * Another customer's visit is indistinguishable from a missing one (404).
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-014…017, 023, 024; INV-6)
 */

import Appointment from '../models/Appointment.js';
import { AppointmentStatus } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { OPEN_STATUSES } from '../constants/appointmentRules.js';
import { fail } from './appointmentErrors.js';
import { RELEASE_HOLDS } from './appointmentHolds.js';
import { normalizeReason, paginateVisits } from './appointmentInput.js';
import { findCustomerRows, findVisitRowsByAnyId, loadVisitContext } from './appointmentQueries.js';
import { groupIntoVisits, deriveVisitStatus, isOpenRow, customerExtras } from './appointmentVisitRules.js';
import { countReschedules } from './appointmentRescheduleChain.js';
import { toCustomerVisit } from './appointmentVisitMapper.js';
import { logStatusChanges } from './appointmentAudit.js';
import { MailEvent } from './appointmentMailTemplates.js';
import { dispatchMail, describeVisit } from './appointmentMailService.js';

const requireCustomer = (customerId) => {
  if (!customerId) throw fail(MSG.MSG31); // C13
};

/** DTOs of a page of visits, with how often each was rescheduled and whether it still can be (REQ-024). */
const present = async (visits, now) => {
  const [{ carsById }, counts] = await Promise.all([loadVisitContext(visits), countReschedules(visits)]);
  return visits.map((visit) => toCustomerVisit(visit, carsById, customerExtras(visit, counts.get(visit.visitId), now)));
};

/**
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-014
 * @param {object} p
 * @param {string} p.customerId
 * @param {object} [p.query]  `{ status?, page?, limit? }`
 */
export const listMyVisits = async ({ customerId, query = {}, now = new Date() }) => {
  requireCustomer(customerId);
  let visits = groupIntoVisits(await findCustomerRows(customerId));
  if (query.status) visits = visits.filter((visit) => deriveVisitStatus(visit.rows) === query.status);
  const { items, pagination } = paginateVisits(visits, query);
  return { visits: await present(items, now), pagination };
};

/** Loads the customer's visit that contains appointment `id`, or throws 404. */
const loadOwnVisit = async (customerId, id) => {
  const rows = await findVisitRowsByAnyId(id, { customerId });
  if (rows.length === 0) throw fail(MSG.MSG38);
  return groupIntoVisits(rows)[0];
};

/** @ears .sdd/features/test-drive-booking/SPEC.md#REQ-015 */
export const getMyVisit = async ({ customerId, id, now = new Date() }) => {
  requireCustomer(customerId);
  const [visit] = await present([await loadOwnVisit(customerId, id)], now);
  return visit;
};

const assertCancellable = (visit, now) => {
  const status = deriveVisitStatus(visit.rows);
  if (status === AppointmentStatus.CANCELLED) throw fail(MSG.MSG39);
  const stillOpen = visit.rows.some(isOpenRow);
  if (!stillOpen || visit.scheduledAt.getTime() <= now.getTime()) throw fail(MSG.MSG81);
};

/**
 * Cancels every open appointment of the visit (customers never cancel single cars).
 * Compare-and-set on status, so a concurrent change cannot be overwritten silently.
 *
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-016
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-017
 */
export const cancelMyVisit = async ({ customerId, userId, id, reason, ipAddress, now = new Date() }) => {
  requireCustomer(customerId);
  const note = normalizeReason(reason);
  const visit = await loadOwnVisit(customerId, id);
  assertCancellable(visit, now);

  const open = visit.rows.filter(isOpenRow);
  const result = await Appointment.updateMany(
    { _id: { $in: open.map((row) => row._id) }, status: { $in: OPEN_STATUSES }, isActive: true },
    { $set: { status: AppointmentStatus.CANCELLED, cancellationReason: note, updatedBy: userId }, $unset: RELEASE_HOLDS },
  );

  const fresh = await loadOwnVisit(customerId, id);
  if (result.modifiedCount === 0) {
    assertCancellable(fresh, now); // somebody else changed it first: report why
    throw fail(MSG.MSG81);
  }
  const changes = open
    .filter((row) => fresh.rows.some((r) => String(r._id) === String(row._id) && r.status === AppointmentStatus.CANCELLED))
    .map((row) => ({ appointment: row, from: row.status }));
  await logStatusChanges(changes, { status: AppointmentStatus.CANCELLED, userId, ipAddress, metadata: { reason: note } });
  const { carsById } = await loadVisitContext([fresh]);
  dispatchMail({
    event: MailEvent.CANCELLED_BY_CUSTOMER, customerId, data: describeVisit(open, carsById, fresh.rows),
  });
  const counts = await countReschedules([fresh]);
  return toCustomerVisit(fresh, carsById, customerExtras(fresh, counts.get(fresh.visitId), now));
};

export default { listMyVisits, getMyVisit, cancelMyVisit };
