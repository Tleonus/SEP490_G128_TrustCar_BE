/**
 * @file depositTransaction.js
 * @description KAN-22 – runs a deposit write inside a MongoDB transaction when the
 * deployment supports it (replica set / sharded / Atlas), retrying on write conflicts.
 *
 * The topology is detected once (`hello` command, read-only). On a STANDALONE server
 * (no transaction support – the current local `trustcar` database) the work runs once
 * with `session = null`; the deposit service is written so that every step is a
 * conditional atomic update with compensation, and the expiry job reconciles anything
 * left half-done after a crash.
 */

import mongoose from 'mongoose';
import { withTransaction } from './withTransaction.js';
import logger from './logger.js';

const isWriteConflict = (error) => Boolean(error?.hasErrorLabel?.('TransientTransactionError'));

const isTransactionUnsupported = (error) =>
  error?.code === 20 /* IllegalOperation */
  || /Transaction numbers are only allowed|does not support transactions|replica set/i.test(error?.message || '');

let supportPromise = null;

/** @returns {Promise<boolean>} whether the connected deployment supports multi-document transactions. */
export const supportsTransactions = () => {
  if (!supportPromise) {
    supportPromise = (async () => {
      try {
        const hello = await mongoose.connection.db.admin().command({ hello: 1 });
        const ok = Boolean(hello.setName || hello.msg === 'isdbgrid');
        if (!ok) logger.warn('[deposit] MongoDB is STANDALONE – transactions unavailable; using conditional updates with compensation.');
        return ok;
      } catch (error) {
        supportPromise = null; // retry detection on next call
        logger.warn(`[deposit] could not detect MongoDB topology: ${error.message}`);
        return false;
      }
    })();
  }
  return supportPromise;
};

const backoff = (attempt) => new Promise((resolve) => {
  setTimeout(resolve, attempt * (20 + Math.random() * 80));
});

/**
 * @template T
 * @param {(session: import('mongoose').ClientSession|null) => Promise<T>} work
 * @param {{ maxAttempts?: number }} [options]
 * @returns {Promise<T>}
 */
export const runDepositAtomic = async (work, { maxAttempts = 4 } = {}) => {
  if (!(await supportsTransactions())) return work(null);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withTransaction(work);
    } catch (error) {
      if (isTransactionUnsupported(error)) {
        supportPromise = Promise.resolve(false);
        return work(null);
      }
      if (!isWriteConflict(error) || attempt >= maxAttempts) throw error;
      await backoff(attempt);
    }
  }
};

export default { runDepositAtomic, supportsTransactions };
