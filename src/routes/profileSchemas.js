/**
 * @file profileSchemas.js
 * @description Joi schemas of the profile API. Used with `validateBodyStrict`, so an unknown field
 * (`email`, `role`, `password`, `avatar`…) is refused with 422 instead of being dropped silently.
 *
 * Limits live here (not in appConstants) so the feature adds nothing to shared files.
 *
 * Ref: .sdd/features/user-profile-settings/SPEC.md (C7–C11; REQ-005, REQ-013)
 */

import Joi from 'joi';
import { joiPhone } from '../utils/validators.js';
import { isRealDateKey, todayInVietnam } from '../services/profileRules.js';

export const NAME_MIN = 2;
export const NAME_MAX = 100;
export const STREET_MAX = 200;
export const ADDRESS_PART_MAX = 100;
export const OLDEST_BIRTH_DATE = '1900-01-01';

const GENDERS = ['MALE', 'FEMALE', 'OTHER'];

/** A birth date: a real `YYYY-MM-DD` between 1900-01-01 and today (Vietnam time), or null to clear. */
const birthDate = (value, helpers) => {
  if (!isRealDateKey(value)) return helpers.message('dateOfBirth must be a real date in the form YYYY-MM-DD.');
  if (value < OLDEST_BIRTH_DATE) return helpers.message(`dateOfBirth must not be before ${OLDEST_BIRTH_DATE}.`);
  if (value > todayInVietnam()) return helpers.message('dateOfBirth must not be in the future.');
  return value;
};

const addressPart = (max) => Joi.string().trim().max(max).allow('', null);

/**
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-005
 * `phone` is normalised by `joiPhone` (`+84…` → `0…`) and cannot be cleared.
 */
export const updateProfileSchema = Joi.object({
  fullName: Joi.string().trim().min(NAME_MIN).max(NAME_MAX),
  phone: joiPhone(),
  address: Joi.object({
    street: addressPart(STREET_MAX),
    district: addressPart(ADDRESS_PART_MAX),
    city: addressPart(ADDRESS_PART_MAX),
    province: addressPart(ADDRESS_PART_MAX),
  }).min(1),
  dateOfBirth: Joi.alternatives().try(Joi.valid(null), Joi.string().custom(birthDate)),
  gender: Joi.valid(...GENDERS, null),
}).min(1);

/** @ears .sdd/features/user-profile-settings/SPEC.md#REQ-013 */
export const updateSettingsSchema = Joi.object({
  marketingConsent: Joi.boolean().strict().required(),
});

export default { updateProfileSchema, updateSettingsSchema };
