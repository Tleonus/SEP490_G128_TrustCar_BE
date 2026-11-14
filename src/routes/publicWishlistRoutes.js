/**
 * @file publicWishlistRoutes.js
 * @description Public read-only endpoints supporting Guest `localStorage` wishlist mode.
 * Guests can save vehicles locally in browser `localStorage` (with a Signup Prompt Popup)
 * and preview up-to-date public vehicle cards here without writing to the database.
 */

import { Router } from 'express';
import Joi from 'joi';
import * as wishlistController from '../controllers/wishlistController.js';
import { validateQuery } from '../middlewares/validateMiddleware.js';

const router = Router();

const MAX_GUEST_PREVIEW_IDS = 50;
const MAX_IDS_QUERY_LENGTH = 1500;
const OBJECT_ID_REGEX = /^[0-9a-f]{24}$/;

const parseGuestPreviewIds = (value, helpers) => {
  if (!value || !value.trim()) return [];

  const parts = value.split(',').map((part) => part.trim().toLowerCase());
  if (!parts.every((part) => OBJECT_ID_REGEX.test(part))) {
    return helpers.error('guestWishlist.invalidId');
  }

  const uniqueIds = [...new Set(parts)];
  if (uniqueIds.length > MAX_GUEST_PREVIEW_IDS) {
    return helpers.error('guestWishlist.maxCount');
  }
  return uniqueIds;
};

const guestPreviewQuerySchema = Joi.object({
  ids: Joi.string()
    .allow('')
    .max(MAX_IDS_QUERY_LENGTH)
    .default('')
    .custom(parseGuestPreviewIds)
    .messages({
      'string.base':             'ids must be a comma-separated string of vehicle IDs.',
      'string.max':              `ids must not exceed ${MAX_IDS_QUERY_LENGTH} characters.`,
      'guestWishlist.invalidId': 'Each id must be a valid 24-character hexadecimal vehicle ID.',
      'guestWishlist.maxCount':  `Cannot preview more than ${MAX_GUEST_PREVIEW_IDS} vehicles at once.`,
    }),
});

/**
 * @route   GET /api/v1/public/wishlist/preview?ids=a,b,c
 * @access  Public (no authentication required)
 * @desc    Returns live public vehicle cards for guest localStorage IDs + signup prompt metadata.
 */
router.get(
  '/preview',
  validateQuery(guestPreviewQuerySchema),
  wishlistController.previewGuestWishlist
);

export default router;

