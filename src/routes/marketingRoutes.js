/**
 * @file marketingRoutes.js
 * @description Marketing tooling for staff: caption suggestions for social posts.
 * Mounted under /api/v1/marketing.
 *
 * Ref: KAN-68
 */

import { Router } from 'express';
import Joi from 'joi';
import * as captionController from '../controllers/captionController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireRole } from '../middlewares/roleMiddleware.js';
import { createDailyCaptionLimiter } from '../middlewares/rateLimiters.js';
import { validate } from '../middlewares/validateMiddleware.js';
import { Roles } from '../constants/appConstants.js';
import { Tones, Platforms, Lengths } from '../services/captionService.js';

const router = Router();

const captionSchema = Joi.object({
  carId: Joi.string().trim().max(64).required(),
  tone: Joi.string().valid(...Object.values(Tones)).default(Tones.PROFESSIONAL),
  platform: Joi.string().valid(...Object.values(Platforms)).default(Platforms.FACEBOOK),
  length: Joi.string().valid(...Object.values(Lengths)).default(Lengths.MEDIUM),
});

/**
 * @route   POST /api/v1/marketing/caption
 * @access  Admin, Sales staff
 * @desc    Suggests captions for a Facebook/Zalo post about one vehicle.
 *          Only ADMIN and SALES_STAFF: inspectors have no marketing duties.
 */
router.post(
  '/caption',
  verifyToken,
  requireRole(Roles.ADMIN, Roles.SALES_STAFF),
  createDailyCaptionLimiter(),
  validate(captionSchema),
  captionController.suggestCaption,
);

export default router;
