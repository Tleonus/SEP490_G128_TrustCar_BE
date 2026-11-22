/**
 * @file trackRoutes.js
 * @description KAN-97 — POST /api/v1/track (public, rate-limited).
 *
 * Dùng `optionalAuth` để nếu khách có token thì event gắn với customer qua
 * VisitorSession; khách ẩn danh vẫn được, chỉ không có customerId.
 */

import { Router } from 'express';
import * as controller from '../controllers/trackingController.js';
import { optionalAuth } from '../middlewares/authMiddleware.js';
import { createTrackLimiter } from '../middlewares/rateLimiters.js';
import { validate } from '../middlewares/validateMiddleware.js';
import { trackEventSchema } from './trackSchemas.js';

const router = Router();

router.post('/', createTrackLimiter(), optionalAuth, validate(trackEventSchema), controller.track);

export default router;
