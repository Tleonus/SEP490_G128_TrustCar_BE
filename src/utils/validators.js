/**
 * @file validators.js
 * @description Regex validators and Joi schemas for domain-specific data formats
 * used across the TrustCar platform.
 *
 * Includes:
 * - Vietnamese License Plate validation (motorcycle & car formats)
 * - 17-character VIN validation (ISO 3779)
 * - Vietnamese phone number normalization (Ref: GBR-16)
 * - Password complexity check (Ref: GBR-22)
 * - Reusable Joi base schemas for DTO validation layers
 */

import Joi from 'joi';
import dayjs from 'dayjs';

// ════════════════════════════════════════════════════════════════════════════
// RAW REGEX PATTERNS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Vietnamese License Plate patterns:
 *
 * Car (standard):     2-digit province code + 1 letter series + 4-5 digits
 *   Examples: 51A-12345, 29B-567.89, 30G-999.99
 *
 * Motorcycle:         2-digit province code + 2 letter series + 5 digits
 *   Examples: 51H1-23456, 29L2-34567
 *
 * Special (military, government): broader pattern
 *
 * Ref: GBR-08
 */
export const PLATE_REGEX = /^[0-9]{2}[A-Z]{1,2}[-\s]?[0-9]{4,5}(\.[0-9]{2})?$/;

/**
 * Validates a Vietnamese license plate number (case-insensitive after normalization).
 * @param {string} plate
 * @returns {boolean}
 */
export const isValidVietnamesePlate = (plate) => {
  if (!plate || typeof plate !== 'string') return false;
  const normalized = plate.trim().toUpperCase().replace(/\s+/g, '');
  return PLATE_REGEX.test(normalized);
};

/**
 * Normalizes a Vietnamese license plate to a canonical format.
 * Removes spaces, converts to uppercase.
 * @param {string} plate
 * @returns {string}
 */
export const normalizePlate = (plate) => {
  if (!plate) return '';
  return plate.trim().toUpperCase().replace(/\s+/g, '');
};

// ── VIN (ISO 3779) ─────────────────────────────────────────────────────────
/**
 * VIN must be exactly 17 characters: letters A-Z (excluding I, O, Q) and digits 0-9.
 * Ref: GBR-04
 */
export const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/;

/**
 * Validates a 17-character VIN.
 * @param {string} vin
 * @returns {boolean}
 */
export const isValidVIN = (vin) => {
  if (!vin || typeof vin !== 'string') return false;
  return VIN_REGEX.test(vin.trim().toUpperCase());
};

/**
 * Normalizes a VIN to uppercase.
 * @param {string} vin
 * @returns {string}
 */
export const normalizeVIN = (vin) => {
  if (!vin) return '';
  return vin.trim().toUpperCase();
};

// ── Vietnamese Phone Numbers ───────────────────────────────────────────────
/**
 * Accepts:
 *   - 10-digit format starting with 0: 0[3-9]xxxxxxxx
 *   - 11-digit with +84 country code: +84[3-9]xxxxxxxxx
 *
 * Ref: GBR-16
 */
export const PHONE_REGEX = /^(0[3-9][0-9]{8}|\+84[3-9][0-9]{8})$/;

/**
 * Validates a Vietnamese phone number.
 * @param {string} phone
 * @returns {boolean}
 */
export const isValidVietnamesePhone = (phone) => {
  if (!phone || typeof phone !== 'string') return false;
  const cleaned = phone.replace(/[\s\-().]/g, '');
  return PHONE_REGEX.test(cleaned);
};

/**
 * Normalizes a Vietnamese phone number to the 10-digit 0xxxxxxxxx format.
 * +84xxxxxxxxx → 0xxxxxxxxx
 * Ref: GBR-16
 *
 * @param {string} phone
 * @returns {string} Normalized 10-digit phone or original if cannot normalize.
 */
export const normalizePhone = (phone) => {
  if (!phone) return '';
  const cleaned = phone.replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+84')) {
    return '0' + cleaned.slice(3);
  }
  return cleaned;
};

// ── Password Complexity ────────────────────────────────────────────────────
/**
 * 8–128 chars, at least:
 *   - 1 uppercase (A-Z)
 *   - 1 lowercase (a-z)
 *   - 1 digit (0-9)
 * Allowed characters: Latin letters, digits and the special characters !@#$%^&*-_=+
 * (special characters are optional; no spaces or accented letters).
 *
 * Ref: GBR-22
 */
export const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z\d!@#$%^&*\-_=+]{8,128}$/;

/**
 * @param {string} password
 * @returns {boolean}
 */
export const isStrongPassword = (password) => {
  if (!password || typeof password !== 'string') return false;
  return PASSWORD_REGEX.test(password);
};

// ════════════════════════════════════════════════════════════════════════════
// REUSABLE JOI SCHEMA ATOMS
// These are building blocks composed into full DTO schemas in each route file.
// ════════════════════════════════════════════════════════════════════════════

/** Mongoose ObjectId string */
export const joiObjectId = () =>
  Joi.string().pattern(/^[0-9a-fA-F]{24}$/).messages({
    'string.pattern.base': '{{#label}} must be a valid 24-character ObjectId.',
  });

/** Validated Vietnamese plate */
export const joiPlate = () =>
  Joi.string()
    .custom((value, helpers) => {
      if (!isValidVietnamesePlate(value)) {
        return helpers.error('any.invalid');
      }
      return normalizePlate(value);
    })
    .messages({ 'any.invalid': '{{#label}} must be a valid Vietnamese license plate number.' });

/** Validated VIN */
export const joiVIN = () =>
  Joi.string()
    .length(17)
    .pattern(VIN_REGEX)
    .uppercase()
    .messages({
      'string.length':       '{{#label}} must be exactly 17 characters.',
      'string.pattern.base': '{{#label}} must contain only valid VIN characters (A-Z excluding I,O,Q and 0-9).',
    });

/** Validated Vietnamese phone */
export const joiPhone = () =>
  Joi.string()
    .custom((value, helpers) => {
      const norm = normalizePhone(value);
      if (!isValidVietnamesePhone(norm) && !isValidVietnamesePhone(value)) {
        return helpers.error('any.invalid');
      }
      return normalizePhone(value);
    })
    .messages({ 'any.invalid': '{{#label}} must be a valid Vietnamese phone number (0xxxxxxxxx or +84xxxxxxxxx).' });

/** Strong password */
export const joiPassword = () =>
  Joi.string()
    .min(8)
    .max(128)
    .pattern(PASSWORD_REGEX)
    .messages({
      'string.min':          'Password must be at least 8 characters.',
      'string.max':          'Password cannot exceed 128 characters.',
      'string.pattern.base': 'Password must include uppercase, lowercase and digit, and may only contain letters, digits and !@#$%^&*-_=+.',
    });

/** Vehicle production year */
export const joiVehicleYear = () =>
  Joi.number()
    .integer()
    .min(1990)
    .max(dayjs().year() + 1)
    .messages({
      'number.min': 'Production year must be 1990 or later.',
      'number.max': `Production year cannot exceed ${dayjs().year() + 1}.`,
    });

/** Positive price in VND */
export const joiPrice = () =>
  Joi.number()
    .positive()
    .precision(0)
    .messages({ 'number.positive': 'Price must be a positive number in VND.' });

export default {
  isValidVietnamesePlate,
  normalizePlate,
  isValidVIN,
  normalizeVIN,
  isValidVietnamesePhone,
  normalizePhone,
  isStrongPassword,
  joiObjectId,
  joiPlate,
  joiVIN,
  joiPhone,
  joiPassword,
  joiVehicleYear,
  joiPrice,
};
