/**
 * @file healthController.js
 * @description Service heartbeat and readiness probe endpoints.
 *
 * Exposes:
 * - GET /api/v1/health        → Liveness probe (always 200 if process is running)
 * - GET /api/v1/health/ready  → Readiness probe (checks DB connection)
 *
 * These are used by load balancers, container orchestrators (Docker/K8s),
 * and monitoring tools to determine service availability.
 */

import mongoose from 'mongoose';
import { sendSuccess } from '../utils/apiResponse.js';
import dayjs from 'dayjs';

const START_TIME = Date.now();

/**
 * @route   GET /api/v1/health
 * @access  Public
 * @desc    Liveness probe – returns 200 as long as the Node process is alive.
 */
export const liveness = (_req, res) => {
  return sendSuccess(res, 200, 'TrustCar API is running.', {
    service: 'TrustCar-Backend',
    version: process.env.npm_package_version || '1.0.0',
    env: process.env.NODE_ENV || 'development',
    uptime: `${Math.floor((Date.now() - START_TIME) / 1000)}s`,
    timestamp: dayjs().toISOString(),
  });
};

/**
 * @route   GET /api/v1/health/ready
 * @access  Public
 * @desc    Readiness probe – checks MongoDB connection state.
 *          Returns 200 (ready) or 503 (not ready).
 */
export const readiness = (_req, res) => {
  const dbState = mongoose.connection.readyState;
  // Mongoose states: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  const isReady = dbState === 1;

  const dbStatusMap = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };

  if (isReady) {
    return sendSuccess(res, 200, 'Service is ready.', {
      database: dbStatusMap[dbState],
      uptime: `${Math.floor((Date.now() - START_TIME) / 1000)}s`,
      timestamp: dayjs().toISOString(),
    });
  }

  return res.status(503).json({
    success: false,
    message: 'Service is not ready – database connection unavailable.',
    code: 'SERVICE_UNAVAILABLE',
    database: dbStatusMap[dbState] || 'unknown',
    timestamp: dayjs().toISOString(),
  });
};

export default { liveness, readiness };
