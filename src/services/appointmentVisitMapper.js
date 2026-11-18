/**
 * @file appointmentVisitMapper.js
 * @description Pure DTO mappers for visits. Every field is picked explicitly
 * (allow-list): nothing is spread from a database document, so a field added to
 * the models later can never leak by accident (REQ-024).
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (section 5, REQ-024)
 */

import {
  bookedAtOf, cancellationOf, deriveVisitStatus, isLateCancellation, visitCodeOf,
} from './appointmentVisitRules.js';
import { CancellationType } from '../constants/appointmentRules.js';

const idOf = (value) => (value == null ? null : String(value));
const iso = (value) => (value ? new Date(value).toISOString() : null);

/** Primary image url → first image → null. Never exposes `publicId`. */
const primaryImageUrl = (images) => {
  if (!Array.isArray(images) || images.length === 0) return null;
  return (images.find((image) => image.isPrimary) ?? images[0]).url ?? null;
};

const carFields = (row, car) => ({
  _id: idOf(row.car),
  vehicleCode: car?.vehicleCode ?? null,
  make: car?.make ?? null,
  model: car?.model ?? null,
  variant: car?.variant ?? null,
  year: car?.year ?? null,
  primaryImageUrl: primaryImageUrl(car?.images),
});

const appointmentItem = (row, carsById, withCarStatus) => {
  const car = carsById.get(idOf(row.car));
  return {
    _id: idOf(row._id),
    appointmentCode: row.appointmentCode,
    status: row.status,
    car: withCarStatus ? { ...carFields(row, car), status: car?.status ?? null } : carFields(row, car),
  };
};

/** Fields shared by the customer and staff views. */
const commonFields = (visit) => {
  const first = visit.rows[0];
  const cancellation = cancellationOf(visit.rows);
  const late = cancellation?.type === CancellationType.CUSTOMER && cancellation.cancelledAt
    ? isLateCancellation(visit.scheduledAt, bookedAtOf(visit.rows), cancellation.cancelledAt)
    : false;
  return {
    visitId: visit.visitId,
    visitCode: visitCodeOf(visit.rows),
    type: first.type,
    status: deriveVisitStatus(visit.rows),
    scheduledAt: iso(visit.scheduledAt),
    durationMinutes: first.durationMinutes ?? null,
    location: first.location ?? null,
    notes: first.notes ?? null,
    cancellationType: cancellation?.type ?? null,
    cancellationReason: cancellation?.reason ?? null,
    isLateCancellation: late,
    createdAt: iso(bookedAtOf(visit.rows)),
  };
};

/**
 * Customer view of a visit.
 * @param {{visitId, scheduledAt, rows}} visit
 * @param {Map<string, object>} carsById lean Car docs keyed by string id
 * @param {{ rescheduleCount?: number, canReschedule?: boolean }} [extras] Computed by the service.
 */
export const toCustomerVisit = (visit, carsById, extras = {}) => ({
  ...commonFields(visit),
  rescheduleCount: extras.rescheduleCount ?? 0,
  canReschedule: extras.canReschedule ?? false,
  appointments: visit.rows.map((row) => appointmentItem(row, carsById, false)),
});

const person = (user) => (user ? { _id: idOf(user._id), fullName: user.fullName ?? null } : null);

/**
 * Staff view: customer contact, handling staff, outcome and the car's current status.
 * @param {Map<string, object>} customersById lean Customer docs
 * @param {Map<string, object>} usersById lean User docs (assignedTo / confirmedBy)
 * @param {{ rescheduleCount?: number, needsReminderCall?: boolean, needsOutcome?: boolean }} [extras]
 */
export const toStaffVisit = (visit, carsById, customersById, usersById, extras = {}) => {
  const rows = visit.rows;
  const customer = customersById.get(idOf(visit.customer));
  const assigned = rows.find((row) => row.assignedTo)?.assignedTo;
  const confirmed = rows.find((row) => row.confirmedBy);
  return {
    ...commonFields(visit),
    customer: customer
      ? { _id: idOf(customer._id), fullName: customer.fullName ?? null, phone: customer.phone ?? null, email: customer.email ?? null }
      : { _id: idOf(visit.customer), fullName: null, phone: null, email: null },
    assignedTo: person(usersById.get(idOf(assigned))),
    confirmedBy: person(usersById.get(idOf(confirmed?.confirmedBy))),
    confirmedAt: iso(confirmed?.confirmedAt),
    cancellationNote: cancellationOf(rows)?.note ?? null, // internal note: staff only (C20)
    rescheduleCount: extras.rescheduleCount ?? 0,
    needsReminderCall: extras.needsReminderCall ?? false,
    needsOutcome: extras.needsOutcome ?? false,
    isNewRequest: extras.isNewRequest ?? false,
    completedAt: iso(rows.find((row) => row.completedAt)?.completedAt),
    outcome: rows.find((row) => row.outcome)?.outcome ?? null,
    appointments: rows.map((row) => appointmentItem(row, carsById, true)),
  };
};
