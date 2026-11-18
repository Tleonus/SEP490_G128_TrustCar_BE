/**
 * @file carCompareSchemas.js
 * @description Query schema shared by the two vehicle-comparison routes:
 * GET /api/v1/public/cars/compare (anyone, including guests) and
 * GET /api/v1/customer/cars/compare (logged-in, kept for older clients).
 *
 * Ref: .sdd/features/vehicle-comparison/SPEC.md (REQ-005, 007, 008)
 */

import Joi from 'joi';

export const MIN_IDS = 2;
export const MAX_IDS = 3;
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

export const compareQuerySchema = Joi.object({
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

export default compareQuerySchema;
