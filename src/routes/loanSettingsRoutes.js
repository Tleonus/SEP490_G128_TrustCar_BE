/**
 * @file loanSettingsRoutes.js
 * @description Loan calculator configuration (KAN-63).
 *
 *   GET /api/v1/settings/loan → public read (placeholder defaults until an admin saves)
 *   PUT /api/v1/settings/loan → ADMIN only
 *
 * The rates are placeholders pending partner-bank confirmation; see
 * src/config/loanSettings.js.
 */

import { Router } from 'express';
import Joi from 'joi';
import * as controller from '../controllers/loanSettingsController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireAdmin } from '../middlewares/roleMiddleware.js';
import { validate } from '../middlewares/validateMiddleware.js';

const router = Router();

const RATE_MAX = 100;
const PCT_MAX = 100;
const TERM_MAX = 360;

const updateLoanSettingsSchema = Joi.object({
  preferredRateAnnual: Joi.number().min(0).max(RATE_MAX).required()
    .messages({ 'any.required': 'preferredRateAnnual is required.' }),
  floatingRateAnnual: Joi.number().min(0).max(RATE_MAX).required()
    .messages({ 'any.required': 'floatingRateAnnual is required.' }),
  minDownPaymentPct: Joi.number().min(0).max(PCT_MAX).required()
    .messages({ 'any.required': 'minDownPaymentPct is required.' }),
  minTermMonths: Joi.number().integer().min(1).max(TERM_MAX).required()
    .messages({ 'any.required': 'minTermMonths is required.' }),
  maxTermMonths: Joi.number().integer().min(1).max(TERM_MAX).required()
    .greater(Joi.ref('minTermMonths'))
    .messages({
      'any.required': 'maxTermMonths is required.',
      'number.greater': 'maxTermMonths must be greater than minTermMonths.',
    }),
});

router.get('/loan', controller.getLoanSettings);
router.put('/loan', verifyToken, requireAdmin, validate(updateLoanSettingsSchema), controller.updateLoanSettings);

export default router;
