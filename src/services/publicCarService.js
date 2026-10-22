/**
 * @file publicCarService.js
 * @description Public vehicle catalog filter engine for unauthenticated browsing.
 *
 * Enforces:
 * - GBR-11: Only AVAILABLE vehicles are exposed publicly (hard-coded filter,
 *   cannot be overridden by any caller input).
 *
 * Supported filters (FE-01, FE-02, FE-03):
 * - brand (make)
 * - model
 * - bodyType
 * - fuelType
 * - transmission
 * - priceMin / priceMax (VND)
 * - yearMin / yearMax
 * - mileageMax
 * - search (text search across make, model, vehicleCode)
 * - sortBy (price, year, mileage, createdAt)
 * - sortDir (asc | desc)
 */

import Car from '../models/Car.js';
import { AppError, parsePagination, buildPaginationMeta } from '../utils/apiResponse.js';
import { CarStatus, PAGINATION } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';

// ── Fields exposed on public listing (excludes internal notes, audit fields) ──
const PUBLIC_LIST_PROJECTION = {
  vehicleCode:     1,
  make:            1,
  model:           1,
  variant:         1,
  year:            1,
  bodyType:        1,
  fuelType:        1,
  transmission:    1,
  driveType:       1,
  mileage:         1,
  price:           1,
  status:          1,
  images:          1,
  conditionGrade:  1,
  description:     1,
  createdAt:       1,
  'specifications.numberOfSeats': 1,
  'specifications.engineDisplacementCC': 1,
  'specifications.horsePower': 1,
  'specifications.color': 1,
  'specifications.features': 1,
};

// ── Fields exposed on public detail view (full specs, no internal notes) ──
const PUBLIC_DETAIL_PROJECTION = {
  internalNotes: 0, // Exclude internal notes
  priceHistory:  0, // Price history is staff-only
  createdBy:     0,
  updatedBy:     0,
  statusChangedBy: 0,
  isActive:      0,
};

/**
 * Builds a Mongoose filter object from public query parameters.
 * Always enforces status=AVAILABLE (GBR-11).
 *
 * @param {object} query - Express req.query
 * @returns {object} Mongoose filter document.
 */
const buildPublicFilter = (query) => {
  // GBR-11: AVAILABLE ONLY – immutable base filter
  const filter = {
    status:   CarStatus.AVAILABLE,
    isActive: true,
  };

  // ── Make / Brand filter ──────────────────────────────────────────────
  if (query.brand || query.make) {
    filter.make = { $regex: query.brand || query.make, $options: 'i' };
  }

  // ── Model filter ─────────────────────────────────────────────────────
  if (query.model) {
    filter.model = { $regex: query.model, $options: 'i' };
  }

  // ── Body type ─────────────────────────────────────────────────────────
  if (query.bodyType) {
    filter.bodyType = query.bodyType.toUpperCase();
  }

  // ── Fuel type ─────────────────────────────────────────────────────────
  if (query.fuelType) {
    filter.fuelType = query.fuelType.toUpperCase();
  }

  // ── Transmission ──────────────────────────────────────────────────────
  if (query.transmission) {
    filter.transmission = query.transmission.toUpperCase();
  }

  // ── Price range (VND) ─────────────────────────────────────────────────
  if (query.priceMin || query.priceMax) {
    filter.price = {};
    if (query.priceMin) filter.price.$gte = Number(query.priceMin);
    if (query.priceMax) filter.price.$lte = Number(query.priceMax);
  }

  // ── Year range ────────────────────────────────────────────────────────
  if (query.yearMin || query.yearMax) {
    filter.year = {};
    if (query.yearMin) filter.year.$gte = Number(query.yearMin);
    if (query.yearMax) filter.year.$lte = Number(query.yearMax);
  }

  // ── Mileage max ───────────────────────────────────────────────────────
  if (query.mileageMax) {
    filter.mileage = { $lte: Number(query.mileageMax) };
  }

  // ── Drive type ────────────────────────────────────────────────────────
  if (query.driveType) {
    filter.driveType = query.driveType.toUpperCase();
  }

  // ── Condition grade ───────────────────────────────────────────────────
  if (query.conditionGrade) {
    filter.conditionGrade = query.conditionGrade.toUpperCase();
  }

  // ── Full-text search ──────────────────────────────────────────────────
  if (query.search) {
    const regex = { $regex: query.search, $options: 'i' };
    filter.$or = [
      { make:        regex },
      { model:       regex },
      { variant:     regex },
      { vehicleCode: regex },
      { description: regex },
    ];
  }

  return filter;
};

/**
 * Builds a sort object from query parameters.
 * Allowed sort fields to prevent arbitrary index scans.
 */
const buildPublicSort = (query) => {
  const ALLOWED_SORT_FIELDS = ['price', 'year', 'mileage', 'createdAt'];
  const sortBy  = ALLOWED_SORT_FIELDS.includes(query.sortBy) ? query.sortBy : 'createdAt';
  const sortDir = query.sortDir === 'asc' ? 1 : -1;
  return { [sortBy]: sortDir };
};

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC SERVICE METHODS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Returns a paginated list of AVAILABLE vehicles with applied filters.
 * Ref: FE-01, FE-02, GBR-11
 *
 * @param {object} query - Express req.query
 * @returns {Promise<{ items: Array, pagination: object, filterSummary: object }>}
 */
export const getAvailableCars = async (query) => {
  const { page, limit, skip } = parsePagination(query, PAGINATION.MAX_LIMIT);
  const filter = buildPublicFilter(query);
  const sort   = buildPublicSort(query);

  const [items, total] = await Promise.all([
    Car.find(filter, PUBLIC_LIST_PROJECTION)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    Car.countDocuments(filter),
  ]);

  // Filter summary for front-end breadcrumb / active filter display
  const filterSummary = {};
  if (query.brand || query.make)  filterSummary.brand        = query.brand || query.make;
  if (query.model)                filterSummary.model        = query.model;
  if (query.bodyType)             filterSummary.bodyType     = query.bodyType;
  if (query.fuelType)             filterSummary.fuelType     = query.fuelType;
  if (query.transmission)        filterSummary.transmission  = query.transmission;
  if (query.priceMin)             filterSummary.priceMin     = Number(query.priceMin);
  if (query.priceMax)             filterSummary.priceMax     = Number(query.priceMax);
  if (query.yearMin)              filterSummary.yearMin      = Number(query.yearMin);
  if (query.yearMax)              filterSummary.yearMax      = Number(query.yearMax);
  if (query.mileageMax)           filterSummary.mileageMax   = Number(query.mileageMax);
  if (query.search)               filterSummary.search       = query.search;

  return {
    items,
    pagination:    buildPaginationMeta(total, page, limit),
    filterSummary,
  };
};

/**
 * Returns a single AVAILABLE vehicle's full public detail.
 * Ref: FE-03, GBR-11
 *
 * @param {string} carId - MongoDB ObjectId or vehicleCode.
 * @returns {Promise<object>} Car document with full specifications.
 */
export const getPublicCarDetail = async (carId) => {
  // Support lookup by either _id or vehicleCode
  const isObjectId = /^[0-9a-fA-F]{24}$/.test(carId);
  const filter = isObjectId
    ? { _id: carId,       status: CarStatus.AVAILABLE, isActive: true }
    : { vehicleCode: carId, status: CarStatus.AVAILABLE, isActive: true };

  const car = await Car.findOne(filter, PUBLIC_DETAIL_PROJECTION).lean();

  if (!car) {
    throw new AppError(
      'Vehicle not found or is not currently available.',
      404,
      MSG.MSG61.code
    );
  }

  return car;
};

/**
 * Returns aggregated metadata to populate filter dropdowns.
 * Ref: FE-02
 *
 * @returns {Promise<object>} Available brands, body types, fuel types, price range, year range.
 */
export const getPublicFilterOptions = async () => {
  const baseFilter = { status: CarStatus.AVAILABLE, isActive: true };

  const [brands, bodyTypes, fuelTypes, transmissions, priceRange, yearRange] = await Promise.all([
    Car.distinct('make', baseFilter),
    Car.distinct('bodyType', { ...baseFilter, bodyType: { $ne: null } }),
    Car.distinct('fuelType', { ...baseFilter, fuelType: { $ne: null } }),
    Car.distinct('transmission', { ...baseFilter, transmission: { $ne: null } }),
    Car.aggregate([
      { $match: baseFilter },
      { $group: { _id: null, minPrice: { $min: '$price' }, maxPrice: { $max: '$price' } } },
    ]),
    Car.aggregate([
      { $match: baseFilter },
      { $group: { _id: null, minYear: { $min: '$year' }, maxYear: { $max: '$year' } } },
    ]),
  ]);

  return {
    brands:       brands.sort(),
    bodyTypes,
    fuelTypes,
    transmissions,
    priceRange:   priceRange[0] || { minPrice: 0, maxPrice: 0 },
    yearRange:    yearRange[0]  || { minYear: 2000, maxYear: new Date().getFullYear() },
  };
};

export default {
  getAvailableCars,
  getPublicCarDetail,
  getPublicFilterOptions,
};
