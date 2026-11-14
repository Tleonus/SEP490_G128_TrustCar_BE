/**
 * @file appointmentTransaction.js
 * @description Retry loop around a booking/move transaction.
 *
 * Why retry: two requests that touch the same customer, car or seat can make MongoDB abort one
 * of them (write conflict) or refuse its insert (duplicate key on a unique index). Running the
 * whole transaction again is safe, and it now SEES the winner, so the usual outcome of a retry
 * is the right business error ("car already booked", "slot full") from the rule check itself.
 *
 *   - write conflict (`TransientTransactionError`) and a duplicate on `car` / `visitSeat`:
 *     up to `BOOKING_MAX_ATTEMPTS` tries with a short backoff; after that they are mapped to the
 *     business errors below (never a 500);
 *   - a duplicate `appointmentCode` (another request generated the same code): a fresh code is
 *     generated on the next try; counted separately (`CODE_COLLISION_MAX`) and NOT against the
 *     attempts above, so it cannot starve the other cases;
 *   - anything else is thrown unchanged.
 *
 * Ref: .sdd/features/test-drive-capacity-guard/SPEC.md (REQ-213, AC-11, AC-12, AC-18)
 */

import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { BOOKING_MAX_ATTEMPTS, CODE_COLLISION_MAX } from '../constants/appointmentRules.js';
import { fail } from './appointmentErrors.js';

export const RetryKind = Object.freeze({
  CODE: 'CODE', CAR: 'CAR', SEAT: 'SEAT', CONFLICT: 'CONFLICT',
});

/** What kind of retryable failure `error` is, or null when it must be thrown as it is. */
export const classifyError = (error) => {
  if (error?.hasErrorLabel?.('TransientTransactionError')) return RetryKind.CONFLICT;
  if (error?.code !== 11000) return null;
  const pattern = error.keyPattern ?? {};
  const text = String(error.message ?? '');
  if (pattern.appointmentCode || /appointmentCode/.test(text)) return RetryKind.CODE;
  if (pattern.car || /uniq_visit_car_time/.test(text)) return RetryKind.CAR;
  if (pattern.visitSeat || /uniq_visit_seat_time/.test(text)) return RetryKind.SEAT;
  return null;
};

/**
 * The business error for a clash that survived every retry. A write conflict that never
 * resolved is reported as the slot being full: the slot is the shared resource in dispute and
 * the customer can simply pick another one.
 */
export const exhaustedError = (kind) => (kind === RetryKind.CAR ? fail(MSG.MSG37) : fail(MSG.MSG83));

const defaultSleep = (attempt) => new Promise((resolve) => {
  setTimeout(resolve, 10 * attempt + Math.floor(Math.random() * 20));
});

/**
 * @template T
 * @param {(attempt: number) => Promise<T>} work  One complete try (opens and commits its own transaction).
 * @param {{ sleep?: (attempt: number) => Promise<void> }} [options]  `sleep` replaces the backoff (tests).
 * @returns {Promise<T>}
 */
export const runWithRetry = async (work, { sleep = defaultSleep } = {}) => {
  let attempts = 0;
  let codeCollisions = 0;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await work(attempts + codeCollisions + 1);
    } catch (error) {
      const kind = classifyError(error);
      if (kind === null) throw error;
      if (kind === RetryKind.CODE) {
        codeCollisions += 1;
        if (codeCollisions >= CODE_COLLISION_MAX) throw fail(MSG.MSG62);
      } else {
        attempts += 1;
        if (attempts >= BOOKING_MAX_ATTEMPTS) throw exhaustedError(kind);
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(attempts + codeCollisions);
    }
  }
};

export default { runWithRetry, classifyError, exhaustedError, RetryKind };
