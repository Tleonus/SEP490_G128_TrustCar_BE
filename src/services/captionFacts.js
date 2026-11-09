/**
 * @file captionFacts.js
 * @description Builds the fact sheet a caption may talk about. Every field comes
 * straight from the car document — nothing here is inferred, rounded or guessed.
 *
 * The prompt only ever sees `facts`, and the post-check only ever trusts `facts`.
 * That pairing is what keeps a caption from inventing a spec: a model that writes
 * "2.0L" or "7 chỗ" has no way to get that number past `captionGuard.js`.
 *
 * KAN-68 §3: real DB fields only — make, model, year, mileage, transmission,
 * fuel type, price, CPO certificate code, number of passed criteria groups.
 */

import { formatSharePrice, resolveShareImage } from '../utils/shareFormat.js';
import { Transmission, FuelType, BodyType } from '../constants/appConstants.js';
import { getChecklist } from '../config/inspectionChecklist.js';

const TRANSMISSION_LABEL = {
  [Transmission.MANUAL]: 'số sàn',
  [Transmission.AUTOMATIC]: 'số tự động',
  [Transmission.CVT]: 'hộp số CVT',
  [Transmission.DCT]: 'hộp số ly hợp kép',
};

const FUEL_LABEL = {
  [FuelType.GASOLINE]: 'xăng',
  [FuelType.DIESEL]: 'dầu diesel',
  [FuelType.HYBRID]: 'hybrid',
  [FuelType.ELECTRIC]: 'điện',
  [FuelType.LPG]: 'gas',
};

const BODY_LABEL = {
  [BodyType.SEDAN]: 'sedan',
  [BodyType.SUV]: 'SUV',
  [BodyType.HATCHBACK]: 'hatchback',
  [BodyType.PICKUP]: 'bán tải',
  [BodyType.VAN]: 'van',
  [BodyType.COUPE]: 'coupe',
  [BodyType.CONVERTIBLE]: 'mui trần',
  [BodyType.WAGON]: 'wagon',
};

/**
 * @typedef {object} CaptionFacts
 * @property {string}  make, model, variant
 * @property {number}  year, mileage, price
 * @property {string}  priceLabel          e.g. "520 triệu"
 * @property {?string} transmission        Vietnamese label
 * @property {?string} fuelType            Vietnamese label
 * @property {?string} bodyType            Vietnamese label
 * @property {?string} conditionGrade      A/B/C/D
 * @property {?string} cpoCode             CPO-YYYYMMDD-XXXX
 * @property {number}  criteriaCount       passed criteria groups (0 when not certified)
 * @property {?string} imageUrl            social image first, then the primary image
 */

/**
 * @param {object} car - a Car document or lean object
 * @returns {CaptionFacts}
 */
export const buildCaptionFacts = (car) => ({
  make: car.make,
  model: car.model,
  variant: car.variant || null,
  year: car.year,
  mileage: car.mileage ?? 0,
  price: car.price,
  priceLabel: formatSharePrice(car.price),
  transmission: TRANSMISSION_LABEL[car.transmission] || null,
  fuelType: FUEL_LABEL[car.fuelType] || null,
  bodyType: BODY_LABEL[car.bodyType] || null,
  conditionGrade: car.conditionGrade || null,
  cpoCode: car.cpoCertificateId || null,
  // A certified car passes all five groups; an uncertified one is not advertised as CPO.
  criteriaCount: car.cpoCertificateId ? (getChecklist() || []).length : 0,
  imageUrl: resolveShareImage(car) || null,
});

/** "TOYOTA Vios 1.5G 2020" — the title every caption is built around. */
export const factsTitle = (facts) =>
  [facts.make, facts.model, facts.variant, facts.year].filter(Boolean).join(' ');

export default { buildCaptionFacts, factsTitle };
