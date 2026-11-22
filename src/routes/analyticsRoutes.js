/**
 * @file analyticsRoutes.js
 * @description KAN-100 — Admin analytics dashboard, mounted at
 *              /api/v1/manage/analytics. All routes require Admin role.
 */

import { Router } from 'express';
import * as analyticsController from '../controllers/analyticsController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireAdmin } from '../middlewares/roleMiddleware.js';
import { validateQueryStrict } from './appointmentSchemas.js';
import { analyticsOverviewQuery } from './analyticsSchemas.js';

const router = Router();

router.use(verifyToken, requireAdmin);

/** @route GET /manage/analytics/overview?from&to */
router.get(
  '/overview',
  validateQueryStrict(analyticsOverviewQuery),
  analyticsController.getOverview,
);

export default router;
