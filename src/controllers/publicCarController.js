/**
 * @file publicCarController.js
 * @description Public vehicle browsing controller – no authentication required.
 * Contains ZERO business logic; delegates everything to publicCarService.js.
 *
 * Routes handled (FE-01, FE-02, FE-03):
 * - GET /api/v1/public/cars             → listAvailableCars (with filters)
 * - GET /api/v1/public/cars/filters     → getFilterOptions (dropdown metadata)
 * - GET /api/v1/public/cars/featured    → getFeaturedCars (homepage showcase)
 * - GET /api/v1/public/cars/:id         → getCarDetail
 */

import * as publicCarService from '../services/publicCarService.js';
import Car from '../models/Car.js';
import { CarStatus } from '../constants/appConstants.js';
import { sendSuccess, sendPaginated } from '../utils/apiResponse.js';

/**
 * @route   GET /api/v1/public/cars
 * @access  Public (no auth required)
 * @query   { page, limit, brand, model, bodyType, fuelType, transmission,
 *            priceMin, priceMax, yearMin, yearMax, mileageMax, search,
 *            sortBy, sortDir }
 * @desc    Returns paginated AVAILABLE vehicles (GBR-11) with optional filters.
 *          Ref: FE-01, FE-02
 */
export const listAvailableCars = async (req, res, next) => {
  try {
    const { items, pagination, filterSummary } = await publicCarService.getAvailableCars(req.query);
    return sendPaginated(res, 'Vehicles retrieved successfully.', items, {
      ...pagination,
      filterSummary,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/v1/public/cars/filters
 * @access  Public
 * @desc    Returns dynamic filter options: available brands, body types,
 *          fuel types, transmissions, price range, and year range.
 *          Used to populate filter dropdowns on the front-end.
 *          Ref: FE-02
 */
export const getFilterOptions = async (_req, res, next) => {
  try {
    const options = await publicCarService.getPublicFilterOptions();
    return sendSuccess(res, 200, 'Filter options retrieved successfully.', options);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/v1/public/cars/featured?limit=8
 * @access  Public (no auth required)
 * @desc    Returns the latest available/CPO-approved cars for homepage showcase.
 *          Ref: FE-01 (featured section)
 */
export const getFeaturedCars = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 8, 20);
    const cars = await Car.find({
      status: { $in: [CarStatus.AVAILABLE, CarStatus.APPROVED_CPO] },
      isActive: true,
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return sendSuccess(res, 200, 'Featured vehicles retrieved successfully.', cars);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/v1/public/cars/:id
 * @access  Public
 * @param   id - MongoDB ObjectId OR vehicleCode (TC-YYYY-NNNN)
 * @desc    Returns full detail of a single AVAILABLE vehicle.
 *          Ref: FE-03
 */
export const getCarDetail = async (req, res, next) => {
  try {
    const car = await publicCarService.getPublicCarDetail(req.params.id);
    return sendSuccess(res, 200, 'Vehicle detail retrieved successfully.', car);
  } catch (error) {
    next(error);
  }
};

export default { listAvailableCars, getFilterOptions, getFeaturedCars, getCarDetail };
