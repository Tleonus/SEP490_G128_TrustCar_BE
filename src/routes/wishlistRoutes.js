/**
 * @file wishlistRoutes.js
 * @description Protected customer routes for Saved Cars Wishlist & Price Drop Alerts
 * (/api/v1/customer/wishlist).
 *
 * Requires an authenticated CUSTOMER account with a completed profile
 * (`verifyToken` + `requireRole(Roles.CUSTOMER)`).
 * Unauthenticated callers receive 401 TOKEN_MISSING so the frontend can
 * persist to `localStorage` and display the Signup Prompt Popup.
 */

import { Router } from 'express';
import Joi from 'joi';
import * as wishlistController from '../controllers/wishlistController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireRole } from '../middlewares/roleMiddleware.js';
import { validate, validateQuery, validateParams } from '../middlewares/validateMiddleware.js';
import { Roles, PAGINATION } from '../constants/appConstants.js';

const router = Router();

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const MAX_SYNC_IDS = 50;

// All wishlist persistence & price-alert routes require a logged-in CUSTOMER
router.use(verifyToken, requireRole(Roles.CUSTOMER));

// ── DTO Schemas ────────────────────────────────────────────────────────────

const paginationQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(PAGINATION.DEFAULT_PAGE),
  limit: Joi.number().integer().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
});

const alertsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(PAGINATION.DEFAULT_PAGE),
  limit: Joi.number().integer().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
  unreadOnly: Joi.boolean().default(false),
});

const saveCarSchema = Joi.object({
  carId: Joi.string()
    .trim()
    .pattern(OBJECT_ID_PATTERN)
    .required()
    .messages({
      'any.required':        'carId is required.',
      'string.empty':        'carId is required.',
      'string.pattern.base': 'carId must be a valid 24-character MongoDB ObjectId.',
    }),
  priceAlertEnabled: Joi.boolean().optional(),
});

const syncWishlistSchema = Joi.object({
  carIds: Joi.array()
    .items(
      Joi.string()
        .trim()
        .pattern(OBJECT_ID_PATTERN)
        .messages({
          'string.pattern.base': 'Each carId must be a valid 24-character MongoDB ObjectId.',
        })
    )
    .max(MAX_SYNC_IDS)
    .required()
    .messages({
      'any.required': 'carIds array is required.',
      'array.base':   'carIds must be an array of vehicle IDs.',
      'array.max':    `Cannot sync more than ${MAX_SYNC_IDS} vehicle IDs in a single request.`,
    }),
  priceAlertEnabled: Joi.boolean().default(true),
});

const toggleAlertSchema = Joi.object({
  priceAlertEnabled: Joi.boolean()
    .required()
    .messages({
      'any.required': 'priceAlertEnabled boolean is required.',
      'boolean.base': 'priceAlertEnabled must be a boolean.',
    }),
});

const carIdParamSchema = Joi.object({
  carId: Joi.string()
    .pattern(OBJECT_ID_PATTERN)
    .required()
    .messages({
      'string.pattern.base': 'carId must be a valid 24-character MongoDB ObjectId.',
      'any.required':        'carId parameter is required.',
    }),
});

const alertIdParamSchema = Joi.object({
  alertId: Joi.string()
    .pattern(OBJECT_ID_PATTERN)
    .required()
    .messages({
      'string.pattern.base': 'alertId must be a valid 24-character MongoDB ObjectId.',
      'any.required':        'alertId parameter is required.',
    }),
});

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * @route   GET /api/v1/customer/wishlist/ids
 * @desc    Lightweight list of saved carIds + unread alerts count for badges/icons.
 */
router.get('/ids', wishlistController.getSavedCarIds);

/**
 * @route   GET /api/v1/customer/wishlist/alerts
 * @desc    Paginated list of Price Drop Alerts across the customer's saved vehicles.
 */
router.get(
  '/alerts',
  validateQuery(alertsQuerySchema),
  wishlistController.getPriceDropAlerts
);

/**
 * @route   PATCH /api/v1/customer/wishlist/alerts/read-all
 * @desc    Marks all unread Price Drop Alerts of the customer as read.
 */
router.patch('/alerts/read-all', wishlistController.markAllAlertsRead);

/**
 * @route   PATCH /api/v1/customer/wishlist/alerts/:alertId/read
 * @desc    Marks a single Price Drop Alert as read.
 */
router.patch(
  '/alerts/:alertId/read',
  validateParams(alertIdParamSchema),
  wishlistController.markAlertRead
);

/**
 * @route   POST /api/v1/customer/wishlist/sync
 * @desc    Syncs guest `localStorage` vehicle IDs into the account wishlist after signup/login.
 */
router.post(
  '/sync',
  validate(syncWishlistSchema),
  wishlistController.syncGuestWishlist
);

/**
 * @route   GET /api/v1/customer/wishlist
 * @desc    Paginated Saved Cars Wishlist with live price-drop comparisons.
 */
router.get(
  '/',
  validateQuery(paginationQuerySchema),
  wishlistController.getWishlist
);

/**
 * @route   POST /api/v1/customer/wishlist
 * @desc    Saves an AVAILABLE vehicle to the customer's wishlist.
 */
router.post(
  '/',
  validate(saveCarSchema),
  wishlistController.saveCar
);

/**
 * @route   PATCH /api/v1/customer/wishlist/:carId/alert
 * @desc    Enables or disables Price Drop Alerts for a saved vehicle.
 */
router.patch(
  '/:carId/alert',
  validateParams(carIdParamSchema),
  validate(toggleAlertSchema),
  wishlistController.togglePriceAlert
);

/**
 * @route   DELETE /api/v1/customer/wishlist/:carId
 * @desc    Removes a vehicle from the customer's wishlist.
 */
router.delete(
  '/:carId',
  validateParams(carIdParamSchema),
  wishlistController.removeCar
);

export default router;

