/**
 * @file testDriveRetry.js
 * @description Transaction retry for test-drive writes. When two transactions change
 * the same document, MongoDB aborts one with a TransientTransactionError; running it
 * again is safe and then sees the winner's result, for example "already cancelled".
 *
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-047
 */

import { TEST_DRIVE_LIMITS } from '../constants/appConstants.js';

export const isWriteConflict = (error) => Boolean(error.hasErrorLabel?.('TransientTransactionError'));

/** Random delay that grows with each attempt, so competing requests spread out. */
export const backoff = (attempt) => new Promise((resolve) => {
  setTimeout(resolve, attempt * (20 + Math.random() * 80));
});

/**
 * Runs a transaction again on a write conflict.
 * @template T
 * @param {() => Promise<T>} work - Starts its own transaction.
 * @returns {Promise<T>}
 * @throws the last conflict once attempts run out, or any other error at once
 */
export const retryOnWriteConflict = async (work) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isWriteConflict(error) || attempt >= TEST_DRIVE_LIMITS.BOOKING_MAX_ATTEMPTS) throw error;
      await backoff(attempt);
    }
  }
};

export default { isWriteConflict, backoff, retryOnWriteConflict };
