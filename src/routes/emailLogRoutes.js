/**
 * @file emailLogRoutes.js
 * @description Admin email delivery log, mounted under /api/v1/admin.
 */

import { Router } from 'express';
import { listEmailLogs } from '../controllers/emailLogController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireAdmin } from '../middlewares/roleMiddleware.js';

const router = Router();

router.get('/email-logs', verifyToken, requireAdmin, listEmailLogs);

export default router;
