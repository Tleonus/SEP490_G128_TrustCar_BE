/**
 * @file loanSettingsRoutes.js
 * @description Loan calculator configuration (KAN-63).
 *
 *   GET /api/v1/settings/loan → public read (defaults until an admin saves)
 *   PUT /api/v1/settings/loan → ADMIN only (scalar fields + bank list)
 *
 * Schema: src/routes/loanSettingsSchemas.js. Defaults: src/config/loanSettings.js.
 */

import { Router } from 'express';
import * as controller from '../controllers/loanSettingsController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireAdmin } from '../middlewares/roleMiddleware.js';
import { validate } from '../middlewares/validateMiddleware.js';
import { updateLoanSettingsSchema } from './loanSettingsSchemas.js';

const router = Router();

router.get('/loan', controller.getLoanSettings);
router.put('/loan', verifyToken, requireAdmin, validate(updateLoanSettingsSchema), controller.updateLoanSettings);

export default router;
