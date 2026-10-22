/**
 * @file apiResponse.js
 * @description Factory / Utility Pattern – Standardized API response wrappers.
 *
 * All controllers must use these helpers to return responses. This guarantees
 * a consistent JSON envelope across all 5 concurrent developers' feature branches:
 *
 * Success:
 *   { success: true, message, data, meta? }
 *
 * Error:
 *   { success: false, message, code, errors? }
 *
 * Usage:
 *   import { sendSuccess, sendError, sendPaginated } from '../utils/apiResponse.js';
 *   return sendSuccess(res, 201, 'Vehicle created.', carData);
 */

/**
 * Sends a standardized successful response.
 *
 * @param {import('express').Response} res
 * @param {number}  statusCode  - HTTP status code (200, 201, etc.)
 * @param {string}  message     - Human-readable success message.
 * @param {*}       [data]      - Response payload (object, array, or null).
 * @param {object}  [meta]      - Optional metadata (e.g., pagination info).
 */
export const sendSuccess = (res, statusCode, message, data = null, meta = null) => {
  const body = { success: true, message };
  if (data !== null && data !== undefined) body.data = data;
  if (meta !== null && meta !== undefined) body.meta = meta;
  return res.status(statusCode).json(body);
};

/**
 * Sends a standardized paginated list response.
 * Automatically constructs meta with pagination context.
 *
 * @param {import('express').Response} res
 * @param {string}  message     - Human-readable success message.
 * @param {Array}   items       - Array of result objects.
 * @param {object}  pagination  - { page, limit, total, totalPages }
 */
export const sendPaginated = (res, message, items, pagination) => {
  return res.status(200).json({
    success: true,
    message,
    data: items,
    meta: {
      page:       pagination.page,
      limit:      pagination.limit,
      total:      pagination.total,
      totalPages: pagination.totalPages,
      hasNext:    pagination.page < pagination.totalPages,
      hasPrev:    pagination.page > 1,
    },
  });
};

/**
 * Sends a standardized error response.
 * Used directly in controllers for known/expected errors.
 *
 * @param {import('express').Response} res
 * @param {number}   statusCode - HTTP status code.
 * @param {string}   message    - Human-readable error message.
 * @param {string}   [code]     - Machine-readable error code (e.g., 'VEHICLE_SOLD_LOCKED').
 * @param {Array}    [errors]   - Validation error detail array.
 */
export const sendError = (res, statusCode, message, code = 'ERROR', errors = null) => {
  const body = { success: false, message, code };
  if (errors) body.errors = errors;
  return res.status(statusCode).json(body);
};

/**
 * Custom application error class that carries HTTP status and machine code.
 * Throw from any Service layer; the global errorMiddleware will catch and format it.
 *
 * @example
 *   throw new AppError('VIN already exists.', 409, 'VIN_DUPLICATE');
 */
export class AppError extends Error {
  /**
   * @param {string} message    - Human-readable error message.
   * @param {number} statusCode - HTTP status code.
   * @param {string} [code]     - Machine-readable code (from SystemMessages).
   * @param {Array}  [errors]   - Optional validation error detail.
   */
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', errors = null) {
    super(message);
    this.name       = 'AppError';
    this.statusCode = statusCode;
    this.code       = code;
    this.errors     = errors;
    this.isOperational = true; // Distinguishes known errors from programming bugs
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Builds pagination metadata from query parameters.
 * Centralises page/limit parsing and clamping to MAX_LIMIT.
 *
 * @param {object} query         - Express req.query object.
 * @param {number} [maxLimit=100]
 * @returns {{ page: number, limit: number, skip: number }}
 */
export const parsePagination = (query, maxLimit = 100) => {
  const page  = Math.max(1, parseInt(query.page,  10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || 20));
  const skip  = (page - 1) * limit;
  return { page, limit, skip };
};

/**
 * Builds a pagination summary object after a database query.
 *
 * @param {number} total  - Total number of matching documents.
 * @param {number} page   - Current page.
 * @param {number} limit  - Page size.
 * @returns {{ total, page, limit, totalPages }}
 */
export const buildPaginationMeta = (total, page, limit) => ({
  total,
  page,
  limit,
  totalPages: Math.ceil(total / limit) || 1,
});

export default { sendSuccess, sendPaginated, sendError, parsePagination, buildPaginationMeta, AppError };
