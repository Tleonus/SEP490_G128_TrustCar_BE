/**
 * @file leadScoringJob.js
 * @description KAN-97 — cron chấm điểm lead định kỳ. Copy pattern của
 * `depositExpiryJob.js` nhưng CÓ wire thật trong server.js (xem
 * [[trustcar-integration-gaps]] để nhớ sai lầm cũ).
 */

import { runLeadScoring } from '../services/leadScoringService.js';
import { DEFAULT_SCORING_INTERVAL_MS } from '../constants/leadScoringConstants.js';
import logger from '../utils/logger.js';

const intervalMs = () => {
  const raw = Number(process.env.LEAD_SCORING_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_SCORING_INTERVAL_MS;
};

let timer = null;
let running = false;

const tick = async () => {
  if (running) return;
  running = true;
  try {
    const result = await runLeadScoring();
    if (result.scored > 0) {
      logger.info(`[lead-scoring] scored=${result.scored} hot=${result.hot} warm=${result.warm} cold=${result.cold}`);
    }
  } catch (error) {
    logger.error(`[lead-scoring] scan failed: ${error.message}`);
  } finally {
    running = false;
  }
};

export const startLeadScoringJob = () => {
  if (timer) return;
  timer = setInterval(tick, intervalMs());
  timer.unref(); // không giữ process sống nếu còn mỗi cái này
  setTimeout(tick, 5_000).unref();
  logger.info(`[lead-scoring] started (every ${Math.round(intervalMs() / 1000)}s).`);
};

export const stopLeadScoringJob = () => {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
};

export default { startLeadScoringJob, stopLeadScoringJob };
