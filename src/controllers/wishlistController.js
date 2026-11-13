/**
 * @file wishlistController.js
 * @description HTTP controller for Saved Cars Wishlist & Price Drop Alerts.
 * Contains ZERO business logic; delegates all operations to wishlistService.js.
 */

import * as wishlistService from '../services/wishlistService.js';
import { sendSuccess, sendPaginated } from '../utils/apiResponse.js';

/**
 * @route   GET /api/v1/public/wishlist/preview?ids=a,b,c
 * @access  Public (no authentication – supports Guest localStorage mode)
 */
export const previewGuestWishlist = async (req, res, next) => {
  try {
    const ids = req.query.ids || [];
    const data = await wishlistService.previewGuestWishlist(ids);
    return sendSuccess(res, 200, 'Guest wishlist preview retrieved successfully.', data);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/v1/customer/wishlist/ids
 * @access  Customer only (verifyToken + requireRole CUSTOMER)
 */
export const getSavedCarIds = async (req, res, next) => {
  try {
    const data = await wishlistService.getSavedCarIds(req.userId);
    return sendSuccess(res, 200, 'Saved vehicle IDs retrieved successfully.', data);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/v1/customer/wishlist
 * @access  Customer only
 */
export const getWishlist = async (req, res, next) => {
  try {
    const { items, pagination } = await wishlistService.getWishlist(req.userId, req.query);
    return sendPaginated(res, 'Saved cars wishlist retrieved successfully.', items, pagination);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/v1/customer/wishlist
 * @access  Customer only
 */
export const saveCar = async (req, res, next) => {
  try {
    const result = await wishlistService.saveCarToWishlist({
      userId: req.userId,
      carId: req.body.carId,
      priceAlertEnabled: req.body.priceAlertEnabled,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    const statusCode = result.created ? 201 : 200;
    const message = result.created
      ? 'Vehicle saved to wishlist successfully.'
      : 'Vehicle is already in your wishlist.';

    return sendSuccess(res, statusCode, message, {
      alreadySaved: result.alreadySaved,
      item: result.item,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/v1/customer/wishlist/sync
 * @access  Customer only
 */
export const syncGuestWishlist = async (req, res, next) => {
  try {
    const data = await wishlistService.syncGuestWishlist({
      userId: req.userId,
      carIds: req.body.carIds,
      priceAlertEnabled: req.body.priceAlertEnabled,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    return sendSuccess(res, 200, 'Guest wishlist synced to your account successfully.', data);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PATCH /api/v1/customer/wishlist/:carId/alert
 * @access  Customer only
 */
export const togglePriceAlert = async (req, res, next) => {
  try {
    const item = await wishlistService.togglePriceAlert({
      userId: req.userId,
      carId: req.params.carId,
      priceAlertEnabled: req.body.priceAlertEnabled,
    });
    return sendSuccess(res, 200, 'Price drop alert preference updated successfully.', item);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   DELETE /api/v1/customer/wishlist/:carId
 * @access  Customer only
 */
export const removeCar = async (req, res, next) => {
  try {
    const data = await wishlistService.removeCarFromWishlist({
      userId: req.userId,
      carId: req.params.carId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    return sendSuccess(res, 200, 'Vehicle removed from wishlist successfully.', data);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/v1/customer/wishlist/alerts
 * @access  Customer only
 */
export const getPriceDropAlerts = async (req, res, next) => {
  try {
    const { items, pagination, unreadAlertsCount } = await wishlistService.getPriceDropAlerts(
      req.userId,
      req.query
    );
    return sendSuccess(res, 200, 'Price drop alerts retrieved successfully.', items, {
      page: pagination.page,
      limit: pagination.limit,
      total: pagination.total,
      totalPages: pagination.totalPages,
      hasNext: pagination.page < pagination.totalPages,
      hasPrev: pagination.page > 1,
      unreadAlertsCount,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PATCH /api/v1/customer/wishlist/alerts/read-all
 * @access  Customer only
 */
export const markAllAlertsRead = async (req, res, next) => {
  try {
    const data = await wishlistService.markAllPriceAlertsRead(req.userId);
    return sendSuccess(res, 200, 'All price drop alerts marked as read.', data);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PATCH /api/v1/customer/wishlist/alerts/:alertId/read
 * @access  Customer only
 */
export const markAlertRead = async (req, res, next) => {
  try {
    const data = await wishlistService.markPriceAlertRead({
      userId: req.userId,
      alertId: req.params.alertId,
    });
    return sendSuccess(res, 200, 'Price drop alert marked as read.', data);
  } catch (error) {
    next(error);
  }
};

export default {
  previewGuestWishlist,
  getSavedCarIds,
  getWishlist,
  saveCar,
  syncGuestWishlist,
  togglePriceAlert,
  removeCar,
  getPriceDropAlerts,
  markAllAlertsRead,
  markAlertRead,
};

