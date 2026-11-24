/**
 * @file auditLogRoutes.js
 * @description KAN-92: Audit Log Explorer API, mounted under /api/v1/manage/audit-logs.
 * Same read-only handlers, validation and Admin-only access as the KAN-40 routes under
 * /api/v1/admin/activity-logs (kept for backward compatibility).
 *
 *   GET /manage/audit-logs        ?eventType&action&targetModel&targetId&targetCode&actorEmail&actorId&from&to&sort&page&limit
 *   GET /manage/audit-logs/meta
 *   GET /manage/audit-logs/:id
 */

import { Router } from 'express';
import { getOne, list, meta } from '../controllers/activityLogController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireAdmin } from '../middlewares/roleMiddleware.js';
import { objectIdParamSchema, validateParams } from '../middlewares/validateMiddleware.js';
import { validateQueryStrict } from './appointmentSchemas.js';
import { listQuery } from './activityLogSchemas.js';

const router = Router();

router.use(verifyToken, requireAdmin);

/** `/meta` is declared before `/:id`. */
router.get('/meta', meta);
router.get('/', validateQueryStrict(listQuery), list);
router.get('/:id', validateParams(objectIdParamSchema), getOne);

export default router;
