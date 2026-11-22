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
  marketPrice: 1,
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


// Fields a public caller must never see, whatever projection is in use: cost and
// floor prices, inventory metrics, vehicle identity and audit data stay staff-only.
const PUBLIC_HIDDEN_FIELDS = [
  'originalPrice', 'floorPrice', 'listedPrice', 'priceDropCount', 'priceHistory',
  'daysInStock', 'agingCategory', 'inventoryType', 'listedDate',
  'internalNotes', 'vin', 'licensePlate', 'carModelRef', 'soldAt', 'statusChangedAt',
  'createdBy', 'updatedBy', 'statusChangedBy', 'isActive',
];

// ── Fields exposed on public detail view: an allow-list, so a field added to the
// model later stays hidden until someone deliberately exposes it here ──
const PUBLIC_DETAIL_PROJECTION = {
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
  specifications: 1,
  price: 1,
  marketPrice: 1,
  ownerType: 1,
  status: 1,
  cpoCertificateId: 1,
  images: 1,
  description: 1,
  conditionGrade: 1,
  registrationExpiry: 1,
  createdAt: 1,
  updatedAt: 1,
};

const FEATURED_DEFAULT_LIMIT = 8;
const FEATURED_MAX_LIMIT = 20;

/**
 * Second guard applied after every public query: drops staff-only fields even if a
 * projection is edited by mistake, and trims each image to what the storefront
 * renders (`publicId` is the Cloudinary asset id, `_id` is the FE list key).
 *
 * @param {object} car - Lean Car document.
 * @returns {object} The same object, safe to return to a public caller.
 */
export const toPublicCar = (car) => {
  for (const field of PUBLIC_HIDDEN_FIELDS) delete car[field];
  if (Array.isArray(car.images)) {
    car.images = car.images.map(({ _id, url, isPrimary }) => ({ _id, url, isPrimary }));
  }
  if (car.marketPrice === undefined) car.marketPrice = null;
  return car;
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

const normalizeNoAccent = (text = '') =>
  String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();

const COMPACT_TOKEN_ALIASES = [
  { test: /^cx-?5$/i, pattern: 'cx[-\\s]?5' },
  { test: /^cx-?8$/i, pattern: 'cx[-\\s]?8' },
  { test: /^cx-?3$/i, pattern: 'cx[-\\s]?3' },
  { test: /^cx-?30$/i, pattern: 'cx[-\\s]?30' },
  { test: /^cr-?v$/i, pattern: 'cr[-\\s]?v' },
  { test: /^hr-?v$/i, pattern: 'hr[-\\s]?v' },
  { test: /^br-?v$/i, pattern: 'br[-\\s]?v' },
  { test: /^vf-?([3-9]|e34)$/i, pattern: 'vf[-\\s]?$1' },
  { test: /^mazda-?([236])$/i, pattern: 'mazda[-\\s]?$1' },
  { test: /^santafe$/i, pattern: 'santa[-\\s]?fe' },
  { test: /^huyndai$/i, pattern: '(?:hyundai|huyndai)' },
  { test: /^merc(?:edes)?$/i, pattern: 'mercedes' },
  { test: /^mitsu(?:bishi)?$/i, pattern: 'mitsubishi' },
];

const SEARCH_STOPWORDS = new Set(['xe', 'oto', 'tim', 'mua', 'can', 'doi', 'nam', 'mau', 'dong', 'chiec']);

const buildTokenClause = (token) => {
  const alias = COMPACT_TOKEN_ALIASES.find((a) => a.test.test(token));
  const pattern = alias ? token.replace(alias.test, alias.pattern) : escapeRegex(token);
  const regex = { $regex: pattern, $options: 'i' };

  const orList = [
    { make: regex },
    { model: regex },
    { variant: regex },
    { vehicleCode: regex },
    { bodyType: regex },
    { 'specifications.color': regex },
  ];

  if (/^(199\d|20[0-3]\d)$/.test(token)) {
    orList.push({ year: Number(token) });
  }

  return { $or: orList };
};

const applySmartSearchToFilter = (filter, rawSearch) => {
  const trimmed = String(rawSearch || '').trim();
  if (!trimmed) return;

  const isSingleToken = !/\s/.test(trimmed);
  const isSpecialSingleToken =
    /^(199\d|20[0-3]\d)$/.test(trimmed) ||
    COMPACT_TOKEN_ALIASES.some((a) => a.test.test(trimmed));

  // Keep exact single-keyword 4-field $or contract when a single plain keyword is passed
  if (isSingleToken && !isSpecialSingleToken) {
    const regex = { $regex: escapeRegex(trimmed), $options: 'i' };
    filter.$or = [
      { make: regex },
      { model: regex },
      { variant: regex },
      { vehicleCode: regex },
    ];
    return;
  }

  if (isSingleToken && isSpecialSingleToken) {
    const clause = buildTokenClause(trimmed);
    filter.$or = clause.$or;
    return;
  }

  // Multi-word smart search: detect natural Vietnamese phrases + match all remaining tokens
  let working = trimmed;
  let norm = normalizeNoAccent(working);

  // Normalize multi-word model names into single hyphenated tokens before splitting
  working = working
    .replace(/\bsanta\s+fe\b/gi, 'santafe')
    .replace(/\bmazda\s+([236])\b/gi, 'mazda$1')
    .replace(/\bvf\s+([3-9]|e34)\b/gi, 'vf$1')
    .replace(/\b(cx|cr|hr|br)\s+([358v0]+)\b/gi, '$1-$2');
  norm = normalizeNoAccent(working);

  if (!filter.bodyType) {
    if (/\b(gam cao|suv|crossover|cuv)\b/.test(norm)) {
      filter.bodyType = 'SUV';
      working = working.replace(/gầm\s*cao|gam\s*cao|\bsuv\b|\bcrossover\b|\bcuv\b/gi, ' ');
    } else if (/\b(ban tai|pickup|pick-up)\b/.test(norm)) {
      filter.bodyType = 'PICKUP';
      working = working.replace(/bán\s*tải|ban\s*tai|\bpickup\b|\bpick-up\b/gi, ' ');
    } else if (/\b(sedan|gam thap)\b/.test(norm)) {
      filter.bodyType = 'SEDAN';
      working = working.replace(/\bsedan\b|gầm\s*thấp|gam\s*thap/gi, ' ');
    } else if (/\b(hatchback|hatback)\b/.test(norm)) {
      filter.bodyType = 'HATCHBACK';
      working = working.replace(/\bhatchback\b|\bhatback\b/gi, ' ');
    } else if (/\b(mpv|da dung)\b/.test(norm)) {
      filter.bodyType = 'MPV';
      working = working.replace(/\bmpv\b|đa\s*dụng|da\s*dung/gi, ' ');
    }
  }

  if (!filter.fuelType) {
    if (/\b(may dau|xe dau|diesel)\b/.test(norm)) {
      filter.fuelType = 'DIESEL';
      working = working.replace(/máy\s*dầu|may\s*dau|xe\s*dầu|xe\s*dau|\bdiesel\b/gi, ' ');
    } else if (/\b(may xang|xe xang)\b/.test(norm)) {
      filter.fuelType = 'GASOLINE';
      working = working.replace(/máy\s*xăng|may\s*xang|xe\s*xăng|xe\s*xang/gi, ' ');
    } else if (/\b(hybrid|xang lai dien)\b/.test(norm)) {
      filter.fuelType = 'HYBRID';
      working = working.replace(/\bhybrid\b|xăng\s*lai\s*điện|xang\s*lai\s*dien/gi, ' ');
    } else if (/\b(xe dien|thuan dien)\b/.test(norm)) {
      filter.fuelType = 'ELECTRIC';
      working = working.replace(/xe\s*điện|xe\s*dien|thuần\s*điện|thuan\s*dien/gi, ' ');
    }
  }

  if (!filter.transmission) {
    if (/\b(so tu dong|tu dong)\b/.test(norm)) {
      filter.transmission = 'AUTOMATIC';
      working = working.replace(/số\s*tự\s*động|so\s*tu\s*dong|tự\s*động|tu\s*dong/gi, ' ');
    } else if (/\b(so san)\b/.test(norm)) {
      filter.transmission = 'MANUAL';
      working = working.replace(/số\s*sàn|so\s*san/gi, ' ');
    }
  }

  const rawTokens = working
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const meaningfulTokens = rawTokens.filter(
    (t) => !SEARCH_STOPWORDS.has(normalizeNoAccent(t))
  );

  const tokensToMatch = meaningfulTokens.length > 0 ? meaningfulTokens : rawTokens;

  if (tokensToMatch.length === 1) {
    const clause = buildTokenClause(tokensToMatch[0]);
    filter.$or = clause.$or;
  } else if (tokensToMatch.length > 1) {
    filter.$and = tokensToMatch.map(buildTokenClause);
  }
};

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
  if (query.driveType) filter.driveType = matchOneOrMany(query.driveType, { uppercase: true });
  if (query.conditionGrade) filter.conditionGrade = matchOneOrMany(query.conditionGrade, { uppercase: true });

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
    applySmartSearchToFilter(filter, query.search);
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

  items.forEach(toPublicCar);

  // Filter summary for front-end breadcrumb / active filter display
  const filterSummary = {};
  const make = firstParam(query, 'make', 'brand');
  if (make) filterSummary.make = splitList(make);
  if (query.model) filterSummary.model = splitList(query.model);
  if (query.bodyType) filterSummary.bodyType = splitList(query.bodyType);
  if (query.fuelType) filterSummary.fuelType = splitList(query.fuelType);
  if (query.transmission) filterSummary.transmission = splitList(query.transmission);
  if (query.driveType) filterSummary.driveType = splitList(query.driveType);
  if (query.conditionGrade) filterSummary.conditionGrade = splitList(query.conditionGrade);
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

  return toPublicCar(car);
};

/**
 * Normalises the featured `limit` query value: missing, non-numeric or below 1 → 8;
 * above 20 → 20.
 *
 * @param {unknown} value
 * @returns {number}
 */
export const normalizeFeaturedLimit = (value) => {
  const limit = parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1) return FEATURED_DEFAULT_LIMIT;
  return Math.min(limit, FEATURED_MAX_LIMIT);
};

/**
 * Newest AVAILABLE vehicles for the storefront's featured section, with the same
 * fields as one catalog item. Cars not yet on sale are excluded so every featured
 * card opens a detail page that exists.
 *
 * @param {number} limit - Already normalised with normalizeFeaturedLimit.
 * @returns {Promise<Array<object>>}
 */
export const getFeaturedCars = async (limit) => {
  const cars = await Car.find({ status: CarStatus.AVAILABLE, isActive: true }, PUBLIC_LIST_PROJECTION)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return cars.map(toPublicCar);
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
  getFeaturedCars,
  normalizeFeaturedLimit,
  toPublicCar,
  getPublicFilterOptions,
};
