/**
 * @file depositExpiryJob.js
 * @description KAN-22 – periodic scan that expires deposit holds whose deadline passed
 * without the full payment being verified (PENDING_PAYMENT or DEPOSIT_PAID) and returns
 * the car to AVAILABLE. A paid deposit that expires is flagged REFUND_PENDING.
 *
 * Restart-safe: the state lives in MongoDB (Deposit.expiresAt). The job runs once right
 * after start (catching up holds that expired while the server was down) and then every
 * DEPOSIT_JOB_INTERVAL_MS. Read paths also expire lazily, so the UI is correct even
 * between two scans. Every step is a conditional update, so several instances running
 * the job at the same time cannot double-process a deposit.
 *
 * COMPLETED deposits (full payment verified) are never touched, and a car is only released
 * while it is still RESERVED by the expiring deposit – a SOLD car never goes back to AVAILABLE.
 */

import { expireDeposit, reconcileHolds } from '../services/depositService.js';
import { getDepositSettings } from '../constants/depositConstants.js';
import { findDueExpirations } from '../repositories/depositRepository.js';
import logger from '../utils/logger.js';

/** Expires every due deposit (in batches). Never throws. */
export const runDepositExpiryOnce = async () => {
  const { jobBatchSize } = getDepositSettings();
  let expired = 0;
  try {
    const now = new Date();
    const due = await findDueExpirations(now, jobBatchSize);
    for (const { _id: id } of due) {
      try {
        const closed = await expireDeposit(id, now);
        if (closed) expired += 1;
      } catch (error) {
        // Picked up again on the next scan; the rest of the batch still runs.
        logger.error(`[deposit-job] could not expire deposit ${id}: ${error.message}`);
      }
    }
  } catch (error) {
    logger.error(`[deposit-job] expiry scan failed: ${error.message}`);
  }

  try {
    await reconcileHolds();
  } catch (error) {
    logger.error(`[deposit-job] reconcile failed: ${error.message}`);
  }

  if (expired > 0) logger.info(`[deposit-job] expired ${expired} deposit hold(s).`);
  return { expired };
};

let timer = null;
let kickoffTimer = null;
let running = false;

const tick = async () => {
  if (running) return;
  running = true;
  try {
    await runDepositExpiryOnce();
  } finally {
    running = false;
  }
};

export const startDepositExpiryJob = () => {
  if (timer) return;
  const { jobIntervalMs } = getDepositSettings();
  timer = setInterval(tick, jobIntervalMs);
  timer.unref(); // Must not keep the process alive on its own.
  // Catch up on holds that expired while the server was stopped.
  // Tracked so stop() can cancel it – an untracked catch-up tick would still fire
  // during shutdown, after the HTTP server started closing.
  kickoffTimer = setTimeout(tick, 2_000);
  kickoffTimer.unref();
  logger.info(`[deposit-job] started (every ${Math.round(jobIntervalMs / 1000)}s).`);
};

export const stopDepositExpiryJob = () => {
  clearInterval(timer);
  clearTimeout(kickoffTimer);
  timer = null;
  kickoffTimer = null;
};

export default { runDepositExpiryOnce, startDepositExpiryJob, stopDepositExpiryJob };
