/**
 * @file marketingRoutes.js
 * @description Marketing tooling for staff: caption suggestions for social posts,
 *              and publishing a vehicle post to the configured Facebook Page.
 * Mounted under /api/v1/marketing.
 *
 * Ref: KAN-68 (caption), KAN-91 (Facebook Graph publish)
 */

import { Router } from 'express';
import Joi from 'joi';
import * as captionController from '../controllers/captionController.js';
import * as facebookPublishController from '../controllers/facebookPublishController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireRole } from '../middlewares/roleMiddleware.js';
import { createDailyCaptionLimiter, createDailyPublishLimiter } from '../middlewares/rateLimiters.js';
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

/** KAN-91: caption do Admin chọn từ 3 phương án; ảnh mặc định là ảnh chính của xe. */
const facebookPublishSchema = Joi.object({
  carId: Joi.string().trim().max(64).required(),
  caption: Joi.string().trim().min(1).max(5000).required(),
  imageUrl: Joi.string().trim().uri({ scheme: ['http', 'https'] }).max(2048).allow(null, ''),
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

/**
 * @route   POST /api/v1/marketing/facebook/publish
 * @access  Admin
 * @desc    Đăng ảnh + caption đã chọn lên Facebook Page qua Graph API (KAN-91).
 *          Chỉ ADMIN: đây là bài đăng thật, công khai ngay trên Page của showroom.
 *          Thiếu cấu hình Page token → 503 FACEBOOK_NOT_CONFIGURED, không giả lập thành công.
 */
router.post(
  '/facebook/publish',
  verifyToken,
  requireRole(Roles.ADMIN),
  createDailyPublishLimiter(),
  validate(facebookPublishSchema),
  facebookPublishController.publishCarPost,
);

export default router;
