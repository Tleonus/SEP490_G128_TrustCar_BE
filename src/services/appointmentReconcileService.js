/**
 * @file appointmentReconcileService.js
 * @description Safety net behind the car hook: find open future appointments whose car is no
 * longer sellable and cancel them exactly like the hook would (same reason, log and e-mail).
 *
 * Why it exists: the hook in `carService` can be skipped (`inspectionService` changes a car's
 * status without it) or can fail silently (it must never block the car change). Staff opening
 * the visit list, confirming or moving a visit therefore re-checks the cars first. There is
 * no scheduler: the check runs only when somebody looks (Spec C25).
 *
 * Cost: two reads (open future rows, then the cars among them) and ZERO writes when nothing
 * needs cancelling (NFR-08). It never throws: a failure here must not break the page.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-021, REQ-027, C25, INV-9)
 */

import { CarStatus } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { fail } from './appointmentErrors.js';
import { findBookableCars, findOpenFuture, findUnsellableCars } from './appointmentQueries.js';
import { releaseAppointmentsForCar } from './appointmentAutoCancelService.js';

/** The marker stored in the reason: the car's status, or REMOVED for an inactive (deleted) car. */
const statusMarker = (car) => (car.status !== CarStatus.AVAILABLE ? car.status : 'REMOVED');

const releaseAll = async (cars, { userId, ipAddress }) => {
  let cancelled = 0;
  for (const car of cars) {
    cancelled += await releaseAppointmentsForCar({ carId: car._id, carStatus: statusMarker(car), userId, ipAddress });
  }
  return cancelled;
};

/**
 * Cancels every open future appointment whose car is not sellable.
 *
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-027
 * @param {{ userId?: string|null, ipAddress?: string, now?: Date }} p
 * @returns {Promise<number>} Appointments cancelled (0 when nothing to do or on failure).
 */
export const reconcileOpenAppointments = async ({ userId = null, ipAddress, now = new Date() } = {}) => {
  try {
    const rows = await findOpenFuture(now);
    if (rows.length === 0) return 0;
    const carIds = [...new Set(rows.map((row) => String(row.car)))];
    return await releaseAll(await findUnsellableCars(carIds), { userId, ipAddress });
  } catch (error) {
    console.error('Appointment reconciliation failed:', error.message);
    return 0;
  }
};

/**
 * Same, limited to the given cars (used right before confirming or moving one visit).
 *
 * @param {{ carIds: string[], userId?: string|null, ipAddress?: string }} p
 * @returns {Promise<number>}
 */
export const reconcileCars = async ({ carIds, userId = null, ipAddress }) => {
  try {
    return await releaseAll(await findUnsellableCars(carIds), { userId, ipAddress });
  } catch (error) {
    console.error('Appointment reconciliation failed:', error.message);
    return 0;
  }
};

/**
 * REQ-021: every car must still be sellable. When one is not, the appointments of the
 * unsellable car(s) are cancelled first (reconciliation, with e-mail) and only then the
 * request is refused with 409 `APPOINTMENT_CAR_UNAVAILABLE`.
 *
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-021
 * @param {Array<*>} carIds
 * @returns {Promise<object[]>} The (lean) cars, all sellable.
 */
export const assertCarsSellable = async (carIds, { userId = null, ipAddress } = {}) => {
  const ids = [...new Set(carIds.map(String))];
  const sellable = await findBookableCars(ids);
  if (sellable.length === ids.length) return sellable;
  await reconcileCars({ carIds: ids, userId, ipAddress });
  throw fail(MSG.MSG84);
};

export default { reconcileOpenAppointments, reconcileCars, assertCarsSellable };
