/**
 * @file customerCarRoutes.js
 * @description Logged-in vehicle routes (/api/v1/customer/cars).
 * Requires a valid token (verifyToken rejects incomplete customer profiles with
 * PROFILE_INCOMPLETE). Comparison is open to every role — KAN-57 removed the
 * CUSTOMER-only gate so staff can compare too. Since KAN-11 follow-up the same
 * comparison is also public at GET /api/v1/public/cars/compare (guests can compare);
 * this logged-in route is kept so older clients keep working.
 *
 * Ref: .sdd/features/vehicle-comparison/SPEC.md
 */

import { Router } from 'express';
import * as carCompareController from '../controllers/carCompareController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { validateQuery } from '../middlewares/validateMiddleware.js';
import { compareQuerySchema } from './carCompareSchemas.js';

const router = Router();

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * @route   GET /api/v1/customer/cars/compare?ids=a,b,c
 * @access  Any logged-in role (KAN-57). Anonymous callers get 401.
 * @desc    Side-by-side comparison of 2–3 AVAILABLE vehicles (allow-listed fields only).
 */
router.get(
  '/compare',
  verifyToken,
  validateQuery(compareQuerySchema),
  carCompareController.compareCars
);

export default router;
