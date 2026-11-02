/**
 * @file customerCarRoutes.js
 * @description Customer-only vehicle routes (/api/v1/customer/cars).
 * Requires a logged-in CUSTOMER with a complete profile (verifyToken rejects
 * incomplete profiles with PROFILE_INCOMPLETE). Staff accounts get ROLE_INSUFFICIENT.
 *
 * Ref: .sdd/features/vehicle-comparison/SPEC.md
 */

import { Router } from 'express';
import Joi from 'joi';
import * as carCompareController from '../controllers/carCompareController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireRole } from '../middlewares/roleMiddleware.js';
import { validateQuery } from '../middlewares/validateMiddleware.js';
import { Roles } from '../constants/appConstants.js';

const router = Router();

// ── DTO Schemas ────────────────────────────────────────────────────────────

const MIN_IDS = 2;
const MAX_IDS = 3;
const MAX_IDS_LENGTH = 200;
const OBJECT_ID_REGEX = /^[0-9a-f]{24}$/;

/**
 * Splits `ids` on commas, trims and lower-cases each item, validates every item
 * as a 24-character hex id, removes duplicates (first occurrence wins) and
 * checks that 2–3 different ids remain. Returns the normalised array.
 *
 * @ears .sdd/features/vehicle-comparison/SPEC.md#REQ-005
 * @ears .sdd/features/vehicle-comparison/SPEC.md#REQ-007
 * @ears .sdd/features/vehicle-comparison/SPEC.md#REQ-008
 */
const parseCompareIds = (value, helpers) => {
  const parts = value.split(',').map((part) => part.trim().toLowerCase());
  if (!parts.every((part) => OBJECT_ID_REGEX.test(part))) {
    return helpers.error('compare.invalidId');
  }

  const ids = [...new Set(parts)];
  if (ids.length < MIN_IDS || ids.length > MAX_IDS) {
    return helpers.error('compare.count');
  }
  return ids;
};

const compareQuerySchema = Joi.object({
  ids: Joi.string()
    .max(MAX_IDS_LENGTH)
    .required()
    .custom(parseCompareIds)
    .messages({
      'any.required':      'ids is required: provide 2 to 3 comma-separated vehicle ids.',
      'string.base':       'ids must be a single comma-separated string.',
      'string.empty':      'ids is required: provide 2 to 3 comma-separated vehicle ids.',
      'string.max':        `ids must not exceed ${MAX_IDS_LENGTH} characters.`,
      'compare.invalidId': 'Each id must be a 24-character hexadecimal vehicle id.',
      'compare.count':     `Provide ${MIN_IDS} to ${MAX_IDS} different vehicle ids.`,
    }),
});

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * @route   GET /api/v1/customer/cars/compare?ids=a,b,c
 * @access  Customer only
 * @desc    Side-by-side comparison of 2–3 AVAILABLE vehicles (allow-listed fields only).
 */
router.get(
  '/compare',
  verifyToken,
  requireRole(Roles.CUSTOMER),
  validateQuery(compareQuerySchema),
  carCompareController.compareCars
);

export default router;
