/**
 * @file validateMiddleware.js
 * @description Joi DTO validation middleware factory.
 *
 * Usage:
 *   import { validate } from '../middlewares/validateMiddleware.js';
 *   router.post('/login', validate(loginSchema), authController.login);
 *
 * Validates req.body against the provided Joi schema. On failure, returns a
 * standardized 422 response listing all validation errors (not just the first).
 * On success, the validated (and sanitized/type-coerced) value replaces req.body.
 *
 * Separate validators for query params and route params are also exported.
 */

import Joi from 'joi';
import { sendError } from '../utils/apiResponse.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';

// ── Joi Options ────────────────────────────────────────────────────────────
const JOI_OPTIONS = {
  abortEarly:   false,  // Collect ALL errors, not just the first
  allowUnknown: false,  // Reject unknown fields (strict input)
  stripUnknown: true,   // Remove unknown fields from the validated object
  convert:      true,   // Coerce types where safe (e.g., string → number)
};

/**
 * Formats Joi validation errors into a developer-friendly array.
 * @param {Joi.ValidationError} error
 * @returns {Array<{field: string, message: string}>}
 */
const formatErrors = (error) =>
  error.details.map((detail) => ({
    field:   detail.path.join('.') || 'unknown',
    message: detail.message.replace(/['"]/g, ''),
  }));

// ═══════════════════════════════════════════════════════════════════════════
// REQUEST BODY VALIDATOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns an Express middleware that validates `req.body` against a Joi schema.
 * Replaces req.body with the validated, sanitized value on success.
 *
 * @param {Joi.ObjectSchema} schema - A Joi schema to validate the request body.
 * @returns {import('express').RequestHandler}
 */
export const validate = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, JOI_OPTIONS);

    if (error) {
      return sendError(
        res,
        MSG.MSG42.httpStatus,
        MSG.MSG42.message,
        MSG.MSG42.code,
        formatErrors(error)
      );
    }

    req.body = value; // Replace with sanitized value
    next();
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// QUERY STRING VALIDATOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns an Express middleware that validates `req.query` against a Joi schema.
 * Replaces req.query with the validated value on success.
 *
 * @param {Joi.ObjectSchema} schema
 * @returns {import('express').RequestHandler}
 */
export const validateQuery = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.query, {
      ...JOI_OPTIONS,
      allowUnknown: false,
    });

    if (error) {
      return sendError(
        res,
        MSG.MSG42.httpStatus,
        MSG.MSG42.message,
        MSG.MSG42.code,
        formatErrors(error)
      );
    }

    req.query = value;
    next();
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE PARAMS VALIDATOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns an Express middleware that validates `req.params` against a Joi schema.
 *
 * @param {Joi.ObjectSchema} schema
 * @returns {import('express').RequestHandler}
 */
export const validateParams = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.params, { abortEarly: false });

    if (error) {
      return sendError(
        res,
        MSG.MSG54.httpStatus,
        MSG.MSG54.message,
        MSG.MSG54.code,
        formatErrors(error)
      );
    }

    req.params = value;
    next();
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// SHARED PARAM SCHEMA: MongoDB ObjectId
// ═══════════════════════════════════════════════════════════════════════════

export const objectIdParamSchema = Joi.object({
  id: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'id must be a valid 24-character MongoDB ObjectId.',
      'any.required':        'id parameter is required.',
    }),
});

export default { validate, validateQuery, validateParams };
