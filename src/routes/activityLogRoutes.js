/**
 * @file activityLogRoutes.js
 * @description Admin, read-only access to the activity log (KAN-40), mounted under /api/v1/admin.
 * Authorisation is declared on EACH route (not with router.use) so other /admin/* paths keep their
 * own behaviour. `/meta` is declared before `/:id`.
 *
 * Ref: .sdd/features/system-audit-logs/SPEC.md (REQ-001, REQ-002; C2)
 */

import { Router } from 'express';
import { getOne, list, meta } from '../controllers/activityLogController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireAdmin } from '../middlewares/roleMiddleware.js';
import { objectIdParamSchema, validateParams } from '../middlewares/validateMiddleware.js';
import { validateQueryStrict } from './appointmentSchemas.js';
import { listQuery } from './activityLogSchemas.js';

const router = Router();

/** @route GET /admin/activity-logs/meta */
router.get('/activity-logs/meta', verifyToken, requireAdmin, meta);

/** @route GET /admin/activity-logs?eventType&targetModel&targetId&targetCode&actorEmail&from&to&sort&page&limit */
router.get('/activity-logs', verifyToken, requireAdmin, validateQueryStrict(listQuery), list);

/** @route GET /admin/activity-logs/:id */
router.get('/activity-logs/:id', verifyToken, requireAdmin, validateParams(objectIdParamSchema), getOne);

export default router;
