/**
 * @file publicCarRoutes.js
 * @description Public vehicle catalog routes (/api/v1/public/cars).
 * No authentication required. GBR-11: Only AVAILABLE vehicles exposed.
 *
 * Ref: FE-01 (browse), FE-02 (filter), FE-03 (detail)
 */

import { Router } from 'express';
import Joi from 'joi';
import * as publicCarController from '../controllers/publicCarController.js';
import { validateQuery } from '../middlewares/validateMiddleware.js';
import { BodyType, FuelType, Transmission, DriveType, PAGINATION } from '../constants/appConstants.js';

const router = Router();

// ── DTO Schemas ────────────────────────────────────────────────────────────

const listCarsQuerySchema = Joi.object({
  page:     Joi.number().integer().min(1).default(PAGINATION.DEFAULT_PAGE),
  limit:    Joi.number().integer().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),

  // Brand / Make filter
  brand:        Joi.string().trim().max(60).optional(),
  make:         Joi.string().trim().max(60).optional(),  // alias for brand
  model:        Joi.string().trim().max(100).optional(),

  // Classification filters
  bodyType:     Joi.string().valid(...Object.values(BodyType)).optional(),
  fuelType:     Joi.string().valid(...Object.values(FuelType)).optional(),
  transmission: Joi.string().valid(...Object.values(Transmission)).optional(),
  driveType:    Joi.string().valid(...Object.values(DriveType)).optional(),
  conditionGrade: Joi.string().valid('A', 'B', 'C', 'D').optional(),

  // Price range (VND)
  priceMin: Joi.number().min(0).optional(),
  priceMax: Joi.number().min(0).optional(),

  // Year range
  yearMin: Joi.number().integer().min(1990).optional(),
  yearMax: Joi.number().integer().max(new Date().getFullYear() + 1).optional(),

  // Mileage
  mileageMax: Joi.number().integer().min(0).optional(),

  // Text search
  search: Joi.string().trim().max(100).optional(),

  // Sorting
  sortBy:  Joi.string().valid('price', 'year', 'mileage', 'createdAt').default('createdAt'),
  sortDir: Joi.string().valid('asc', 'desc').default('desc'),
}).and('priceMin', 'priceMax').optional()
  // Allow priceMin/priceMax independently; just validate range when both present
  .custom((value, helpers) => {
    if (value.priceMin && value.priceMax && value.priceMin > value.priceMax) {
      return helpers.error('any.invalid', { message: 'priceMin cannot exceed priceMax.' });
    }
    if (value.yearMin && value.yearMax && value.yearMin > value.yearMax) {
      return helpers.error('any.invalid', { message: 'yearMin cannot exceed yearMax.' });
    }
    return value;
  })
  // Override 'and' to be optional
  .options({ allowUnknown: false });

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * @route   GET /api/v1/public/cars/filters
 * @access  Public
 * @desc    Returns available filter options for the public catalog UI.
 *          Must be registered BEFORE /:id to avoid "filters" being treated as an ID.
 *          Ref: FE-02
 */
router.get('/filters', publicCarController.getFilterOptions);

/**
 * @route   GET /api/v1/public/cars
 * @access  Public
 * @desc    Paginated list of available vehicles with optional filters.
 *          Ref: FE-01, FE-02
 */
router.get('/', publicCarController.listAvailableCars);

/**
 * @route   GET /api/v1/public/cars/:id
 * @access  Public
 * @param   id - MongoDB ObjectId OR vehicleCode (TC-YYYY-NNNN)
 * @desc    Returns full detail for a single available vehicle.
 *          Ref: FE-03
 */
router.get('/:id', publicCarController.getCarDetail);

export default router;
