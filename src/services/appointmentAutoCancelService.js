/**
 * @file appointmentAutoCancelService.js
 * @description When a car stops being sellable (leaves AVAILABLE — sold, reserved, delisted,
 * removed), cancel every open test-drive appointment for that car, mark why, log it and tell
 * the customer by e-mail.
 *
 * Exactly once per row (INV-12): each row is cancelled with its own compare-and-set
 * (`findOneAndUpdate` on "still open"), and only the rows THIS call really changed are
 * logged and e-mailed. So the car hook and the reconciliation can run at the same time
 * without a double e-mail.
 *
 * Called from `carService` through `releaseAppointmentsForCar`, which NEVER throws: a
 * failure here must not block or undo the car's own status change (C8). The reconciliation
 * (REQ-027) and the confirm step (REQ-021) are the second and third guards.
 *
 * Other cars of the same visit are untouched; the e-mail says which car was cancelled and
 * which cars remain.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-022, 023, 028, C7, C8, C24, INV-9, INV-12)
 */

import { AppointmentStatus } from '../constants/appConstants.js';
import { AUTO_CANCEL_PREFIX } from '../constants/appointmentRules.js';
import { findOpenByCar, findRowsOfVisits, loadVisitContext } from './appointmentQueries.js';
import { closeRowKeepingSeat } from './appointmentRelease.js';
import { logStatusChanges } from './appointmentAudit.js';
import { groupIntoVisits, isOpenRow } from './appointmentVisitRules.js';
import { MailEvent } from './appointmentMailTemplates.js';
import { dispatchMail, describeVisit, carTitle } from './appointmentMailService.js';

const visitKey = (row) => `${String(row.customer)}|${new Date(row.scheduledAt).getTime()}`;

/**
 * Cancels one row if it is still open, releasing its holds (and passing the visit's seat to a
 * remaining car, see appointmentRelease.js). Returns the row, or null when somebody else got there first.
 */
const cancelRow = (row, reason, userId) =>
  closeRowKeepingSeat(row, { status: AppointmentStatus.CANCELLED, cancellationReason: reason, updatedBy: userId ?? null });

/** One e-mail per affected visit: which car(s) were cancelled and which remain. */
const notifyCustomers = async (cancelledRows, carStatus) => {
  const pairs = cancelledRows.map((row) => ({ customer: row.customer, scheduledAt: row.scheduledAt }));
  const visits = groupIntoVisits(await findRowsOfVisits(pairs));
  const touched = new Set(cancelledRows.map(visitKey));
  const wanted = visits.filter((visit) => touched.has(`${String(visit.customer)}|${visit.scheduledAt.getTime()}`));
  const { carsById } = await loadVisitContext(wanted);
  wanted.forEach((visit) => {
    const cancelled = cancelledRows.filter((row) => visitKey(row) === `${String(visit.customer)}|${visit.scheduledAt.getTime()}`);
    const remaining = visit.rows.filter(isOpenRow);
    dispatchMail({
      event: MailEvent.CAR_UNAVAILABLE,
      customerId: visit.customer,
      data: {
        ...describeVisit(cancelled, carsById, visit.rows),
        carStatus,
        remainingCars: remaining.map((row) => carTitle(carsById.get(String(row.car)))),
      },
    });
  });
};

/**
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-022
 * @param {object} p
 * @param {string} p.carId
 * @param {string} p.carStatus   New status of the car (or `REMOVED` for a soft delete).
 * @param {string|null} p.userId Who changed the car (or who triggered the reconciliation).
 * @param {string} [p.ipAddress]
 * @returns {Promise<number>} Number of appointments this call cancelled.
 */
export const cancelOpenAppointmentsForCar = async ({ carId, carStatus, userId, ipAddress }) => {
  const open = await findOpenByCar(carId);
  if (open.length === 0) return 0;

  const reason = `${AUTO_CANCEL_PREFIX}${carStatus}`;
  const changed = [];
  for (const row of open) {
    if (await cancelRow(row, reason, userId)) changed.push(row);
  }
  if (changed.length === 0) return 0;

  await logStatusChanges(
    changed.map((row) => ({ appointment: row, from: row.status })),
    { status: AppointmentStatus.CANCELLED, userId, ipAddress, metadata: { reason, carId: String(carId) } },
  );
  try {
    await notifyCustomers(changed, carStatus);
  } catch (error) {
    console.error('Appointment auto-cancel e-mail preparation failed:', error.message);
  }
  return changed.length;
};

/**
 * Same as `cancelOpenAppointmentsForCar` but NEVER throws: this is what `carService` and the
 * reconciliation call, so a problem with appointments can never undo or block the car's own
 * change (C8). Failures are only reported.
 *
 * @returns {Promise<number>} Appointments cancelled (0 on failure).
 */
export const releaseAppointmentsForCar = async (params) => {
  try {
    return await cancelOpenAppointmentsForCar(params);
  } catch (error) {
    console.error('Appointment auto-cancel failed for car', String(params.carId), error.message);
    return 0;
  }
};

export default { cancelOpenAppointmentsForCar, releaseAppointmentsForCar };
