/**
 * @file carCompareService.js
 * @description Side-by-side vehicle comparison for logged-in customers.
 *
 * Read-only: nothing is written and no activity log is created.
 *
 * Internal inventory data (floor/original/listed price, VIN, licence plate,
 * price history, internal notes, audit fields, inspection details…) must never
 * reach a customer. Two independent layers enforce this:
 *   1. COMPARE_PROJECTION – allow-list used in the database query.
 *   2. toCompareDto       – explicit field-by-field mapping of the result.
 * Both are built from the same field lists, so adding a field to the contract
 * means adding it in exactly one place below.
 *
 * Ref: GBR-11 (only AVAILABLE vehicles are visible), SEC-01/02, DATA-01.
 */

import Car from '../models/Car.js';
import { AppError } from '../utils/apiResponse.js';
import { CarStatus } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';

/** Minimum number of still-available vehicles needed to build a comparison. */
export const MIN_COMPARE_CARS = 2;

/** Top-level fields exposed for comparison. */
const BASIC_FIELDS = [
  'vehicleCode', 'make', 'model', 'variant', 'year', 'bodyType', 'fuelType',
  'transmission', 'driveType', 'mileage', 'price', 'ownerType', 'conditionGrade',
];

/** `specifications.*` scalar fields exposed for comparison (`features` is handled separately). */
const SPEC_FIELDS = [
  'color', 'interiorColor', 'numberOfSeats', 'numberOfDoors', 'engineDisplacementCC',
  'horsePower', 'torqueNm', 'fuelConsumption', 'originCountry', 'safetyRating',
];

/** Allow-list projection: `_id` is implicit; images expose url/isPrimary only (never publicId). */
export const COMPARE_PROJECTION = Object.fromEntries([
  ...BASIC_FIELDS,
  ...SPEC_FIELDS.map((field) => `specifications.${field}`),
  'specifications.features',
  'images.url',
  'images.isPrimary',
].map((path) => [path, 1]));

/** Primary image URL, else the first image URL, else null. */
const pickPrimaryImageUrl = (images) => {
  const list = Array.isArray(images) ? images : [];
  const image = list.find((item) => item?.isPrimary) ?? list[0];
  return image?.url ?? null;
};

/**
 * Maps a raw Car document to the public comparison shape.
 * Missing values become `null`; `features` becomes `[]`.
 *
 * @ears .sdd/features/vehicle-comparison/SPEC.md#REQ-012
 * @param {object} car - Lean Car document.
 * @returns {object} Allow-listed comparison DTO.
 */
export const toCompareDto = (car) => {
  const specs = car.specifications ?? {};
  const dto = { _id: String(car._id) };

  BASIC_FIELDS.forEach((field) => { dto[field] = car[field] ?? null; });
  dto.primaryImageUrl = pickPrimaryImageUrl(car.images);

  dto.specifications = {};
  SPEC_FIELDS.forEach((field) => { dto.specifications[field] = specs[field] ?? null; });
  dto.specifications.features = Array.isArray(specs.features) ? [...specs.features] : [];

  return dto;
};

/**
 * Loads the requested vehicles that are still publicly available and returns
 * them in the requested order, plus the ids that could not be returned
 * (not found, sold, delisted or inactive – deliberately not distinguished).
 *
 * @ears .sdd/features/vehicle-comparison/SPEC.md#REQ-006
 * @ears .sdd/features/vehicle-comparison/SPEC.md#REQ-009
 * @ears .sdd/features/vehicle-comparison/SPEC.md#REQ-010
 * @ears .sdd/features/vehicle-comparison/SPEC.md#REQ-011
 * @ears .sdd/features/vehicle-comparison/SPEC.md#REQ-013
 *
 * @param {string[]} ids - Distinct, validated, lower-case ObjectId strings (2–3 items).
 * @returns {Promise<{ cars: object[], unavailableIds: string[] }>}
 * @throws {AppError} COMPARE_NOT_ENOUGH_CARS when fewer than MIN_COMPARE_CARS remain.
 */
export const compareCars = async (ids) => {
  // GBR-11: AVAILABLE + active only, a single query for all ids (NFR-01).
  const docs = await Car.find(
    { _id: { $in: ids }, status: CarStatus.AVAILABLE, isActive: true },
    COMPARE_PROJECTION
  ).lean();

  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
  const found = [];
  const unavailableIds = [];

  ids.forEach((id) => {
    const doc = byId.get(id);
    if (doc) found.push(doc);
    else unavailableIds.push(id);
  });

  if (found.length < MIN_COMPARE_CARS) {
    throw new AppError(MSG.MSG75.message, MSG.MSG75.httpStatus, MSG.MSG75.code, { unavailableIds });
  }

  return { cars: found.map(toCompareDto), unavailableIds };
};

export default { compareCars, toCompareDto, COMPARE_PROJECTION, MIN_COMPARE_CARS };
