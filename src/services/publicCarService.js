/**
 * @file publicCarService.js
 * @description Public vehicle catalog filter engine for unauthenticated browsing.
 *
 * Enforces:
 * - GBR-11: Only AVAILABLE vehicles are exposed publicly (hard-coded filter,
 *   cannot be overridden by any caller input).
 *
 * Supported filters (FE-01, FE-02, FE-03, KAN-32):
 * - search (keyword over make, model, variant, vehicleCode)
 * - make / brand and model, each accepting a comma-separated list
 * - bodyType, fuelType, transmission (comma-separated lists, matched with $in)
 * - color (specifications.color)
 * - minPrice / maxPrice (aliases: priceMin / priceMax)
 * - minYear / maxYear (aliases: yearMin / yearMax)
 * - maxMileage (alias: mileageMax)
 * - sortBy: price_asc | price_desc | year_desc | mileage_asc | newest,
 *   with the legacy sortBy + sortDir pair still accepted
 * - page, limit
 */

import Car from '../models/Car.js';
import { AppError, parsePagination, buildPaginationMeta } from '../utils/apiResponse.js';
import { CarStatus, PAGINATION } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';

// ── Fields exposed on public listing (excludes internal notes, audit fields) ──
const PUBLIC_LIST_PROJECTION = {
  vehicleCode: 1,
  make: 1,
  model: 1,
  variant: 1,
  year: 1,
  bodyType: 1,
  fuelType: 1,
  transmission: 1,
  driveType: 1,
  mileage: 1,
  price: 1,
  status: 1,
  images: 1,
  conditionGrade: 1,
  cpoCertificateId: 1, // lets the catalog show the CPO badge without an extra call
  description: 1,
  createdAt: 1,
  'specifications.numberOfSeats': 1,
  'specifications.engineDisplacementCC': 1,
  'specifications.horsePower': 1,
  'specifications.color': 1,
  'specifications.features': 1,
};

// Fields a public caller must never see, whatever projection is in use.
const PUBLIC_HIDDEN_FIELDS = ['floorPrice', 'originalPrice', 'vin', 'licensePlate', 'internalNotes', 'priceHistory'];

// ── Fields exposed on public detail view (full specs, no internal notes) ──
const PUBLIC_DETAIL_PROJECTION = {
  internalNotes: 0, // Exclude internal notes
  priceHistory: 0, // Price history is staff-only
  createdBy: 0,
  updatedBy: 0,
  statusChangedBy: 0,
  isActive: 0,
};

/**
 * Splits a comma-separated query value into a clean list.
 * "Toyota, Honda," → ["Toyota", "Honda"].
 *
 * @param {unknown} value
 * @returns {string[]}
 */
const splitList = (value) => String(value)
  .split(',')
  .map((part) => part.trim())
  .filter(Boolean);

/**
 * Matches one value exactly, or several with $in. Comparison fields such as
 * make and the enums are stored uppercase, so values are normalised.
 *
 * @param {string} value
 * @param {{ uppercase?: boolean }} [options]
 * @returns {string | { $in: string[] }}
 */
const matchOneOrMany = (value, { uppercase = false } = {}) => {
  const values = splitList(value).map((part) => (uppercase ? part.toUpperCase() : part));
  return values.length > 1 ? { $in: values } : values[0];
};

/**
 * Escapes a keyword so it is matched literally inside a regex.
 * @param {string} value
 * @returns {string}
 */
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * First query param that the caller actually sent.
 * @param {object} query
 * @param {...string} names
 * @returns {string|undefined}
 */
const firstParam = (query, ...names) => names.map((name) => query[name]).find((value) => value !== undefined && value !== '');

/**
 * Builds a Mongoose filter object from public query parameters.
 * Always enforces status=AVAILABLE and isActive=true (GBR-11); no caller
 * input can widen that.
 *
 * @param {object} query - Express req.query
 * @returns {object} Mongoose filter document.
 */
const buildPublicFilter = (query) => {
  const filter = {
    status: CarStatus.AVAILABLE,
    isActive: true,
  };

  // ── Make / brand, one or many (make=Toyota,Honda) ────────────────────
  const make = firstParam(query, 'make', 'brand');
  if (make) filter.make = matchOneOrMany(make, { uppercase: true });

  // ── Model, one or many (model=Camry,Civic) ───────────────────────────
  if (query.model) filter.model = matchOneOrMany(query.model);

  // ── Enum specs, one or many, matched with $in ────────────────────────
  if (query.bodyType) filter.bodyType = matchOneOrMany(query.bodyType, { uppercase: true });
  if (query.fuelType) filter.fuelType = matchOneOrMany(query.fuelType, { uppercase: true });
  if (query.transmission) filter.transmission = matchOneOrMany(query.transmission, { uppercase: true });

  // ── Colour lives inside specifications ───────────────────────────────
  if (query.color) {
    filter['specifications.color'] = { $regex: `^${escapeRegex(query.color.trim())}$`, $options: 'i' };
  }

  // ── Price range (VND). minPrice/maxPrice are canonical, priceMin/priceMax stay for the current FE. ──
  const minPrice = firstParam(query, 'minPrice', 'priceMin');
  const maxPrice = firstParam(query, 'maxPrice', 'priceMax');
  if (minPrice || maxPrice) {
    filter.price = {};
    if (minPrice) filter.price.$gte = Number(minPrice);
    if (maxPrice) filter.price.$lte = Number(maxPrice);
  }

  // ── Year range. minYear/maxYear are canonical, yearMin/yearMax stay for the current FE. ──
  const minYear = firstParam(query, 'minYear', 'yearMin');
  const maxYear = firstParam(query, 'maxYear', 'yearMax');
  if (minYear || maxYear) {
    filter.year = {};
    if (minYear) filter.year.$gte = Number(minYear);
    if (maxYear) filter.year.$lte = Number(maxYear);
  }

  // ── Mileage ceiling ──────────────────────────────────────────────────
  const maxMileage = firstParam(query, 'maxMileage', 'mileageMax');
  if (maxMileage) filter.mileage = { $lte: Number(maxMileage) };

  // ── Keyword over the public-facing text fields, case-insensitive ─────
  if (query.search) {
    const regex = { $regex: escapeRegex(query.search.trim()), $options: 'i' };
    filter.$or = [
      { make: regex },
      { model: regex },
      { variant: regex },
      { vehicleCode: regex },
    ];
  }

  return filter;
};

// Combined sort tokens from KAN-32, plus the field names the FE already sends.
const SORT_TOKENS = {
  price_asc: { price: 1 },
  price_desc: { price: -1 },
  year_desc: { year: -1 },
  year_asc: { year: 1 },
  mileage_asc: { mileage: 1 },
  mileage_desc: { mileage: -1 },
  newest: { createdAt: -1 },
};

/**
 * Builds a sort object from query parameters.
 * Accepts the KAN-32 tokens (price_asc, year_desc, newest, ...) and the
 * legacy sortBy + sortDir pair. Anything outside the whitelist falls back
 * to newest, so a caller cannot trigger an arbitrary index scan.
 *
 * @param {object} query
 * @returns {object}
 */
const buildPublicSort = (query) => {
  const token = String(query.sortBy || '').toLowerCase();
  if (SORT_TOKENS[token]) return SORT_TOKENS[token];

  const LEGACY_FIELDS = { price: 'price', year: 'year', mileage: 'mileage', createdat: 'createdAt' };
  const field = LEGACY_FIELDS[token];
  if (field) return { [field]: query.sortDir === 'asc' ? 1 : -1 };

  return SORT_TOKENS.newest;
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
  const sort = buildPublicSort(query);

  const [items, total] = await Promise.all([
    Car.find(filter, PUBLIC_LIST_PROJECTION)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    Car.countDocuments(filter),
  ]);

  // Defence in depth: the projection already excludes these, but a future
  // edit to it must not start leaking cost or identity fields.
  for (const item of items) {
    for (const field of PUBLIC_HIDDEN_FIELDS) delete item[field];
  }

  // Filter summary for front-end breadcrumb / active filter display
  const filterSummary = {};
  const make = firstParam(query, 'make', 'brand');
  if (make) filterSummary.make = splitList(make);
  if (query.model) filterSummary.model = splitList(query.model);
  if (query.bodyType) filterSummary.bodyType = splitList(query.bodyType);
  if (query.fuelType) filterSummary.fuelType = splitList(query.fuelType);
  if (query.transmission) filterSummary.transmission = splitList(query.transmission);
  if (query.color) filterSummary.color = query.color;
  const minPrice = firstParam(query, 'minPrice', 'priceMin');
  const maxPrice = firstParam(query, 'maxPrice', 'priceMax');
  const minYear = firstParam(query, 'minYear', 'yearMin');
  const maxYear = firstParam(query, 'maxYear', 'yearMax');
  const maxMileage = firstParam(query, 'maxMileage', 'mileageMax');
  if (minPrice) filterSummary.minPrice = Number(minPrice);
  if (maxPrice) filterSummary.maxPrice = Number(maxPrice);
  if (minYear) filterSummary.minYear = Number(minYear);
  if (maxYear) filterSummary.maxYear = Number(maxYear);
  if (maxMileage) filterSummary.maxMileage = Number(maxMileage);
  if (query.search) filterSummary.search = query.search;

  return {
    items,
    pagination: buildPaginationMeta(total, page, limit),
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
    ? { _id: carId, status: CarStatus.AVAILABLE, isActive: true }
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
    brands: brands.sort(),
    bodyTypes,
    fuelTypes,
    transmissions,
    priceRange: priceRange[0] || { minPrice: 0, maxPrice: 0 },
    yearRange: yearRange[0] || { minYear: 2000, maxYear: new Date().getFullYear() },
  };
};

export default {
  getAvailableCars,
  getPublicCarDetail,
  getPublicFilterOptions,
};
