/**
 * @file errorMiddleware.js
 * @description Global centralized error handler – the last middleware in the Express chain.
 *
 * This is the single catch-all for all unhandled errors. It:
 * 1. Distinguishes operational errors (AppError – expected, user-facing) from
 *    programming errors (bugs – unexpected).
 * 2. Handles known Mongoose and JWT error types and translates them to AppErrors.
 * 3. Returns a consistent JSON error envelope regardless of error source.
 * 4. Hides internal stack traces from API consumers in production.
 *
 * Must be registered as the LAST app.use() call in app.js.
 */

import mongoose from 'mongoose';
import { AppError } from '../utils/apiResponse.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';

// ── Error Normalizer ───────────────────────────────────────────────────────
/**
 * Converts known framework errors (Mongoose, JWT) into AppErrors with
 * appropriate HTTP status codes and machine-readable codes.
 *
 * @param {Error} err
 * @returns {AppError}
 */
const normalizeError = (err) => {
  // ── Already an operational AppError ─────────────────────────────────
  if (err instanceof AppError) return err;

  // ── Mongoose: CastError (invalid ObjectId in params) ────────────────
  if (err.name === 'CastError' && err.kind === 'ObjectId') {
    return new AppError(
      `Invalid ID format for field "${err.path}".`,
      422,
      MSG.MSG54.code
    );
  }

  // ── Mongoose: ValidationError (schema-level validation failure) ──────
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((e) => ({
      field:   e.path,
      message: e.message,
    }));
    return new AppError(MSG.MSG42.message, 422, MSG.MSG42.code, errors);
  }

  // ── Mongoose: Duplicate Key (unique index violation) ──────────────────
  if (err.code === 11000) {
    const field  = Object.keys(err.keyValue || {})[0] || 'field';
    const value  = err.keyValue?.[field] || '';
    return new AppError(
      `A record with ${field} "${value}" already exists.`,
      409,
      MSG.MSG66.code
    );
  }

  // ── JWT: TokenExpiredError ────────────────────────────────────────────
  if (err.name === 'TokenExpiredError') {
    return new AppError(MSG.MSG02.message, 401, MSG.MSG02.code);
  }

  // ── JWT: JsonWebTokenError ────────────────────────────────────────────
  if (err.name === 'JsonWebTokenError') {
    return new AppError(MSG.MSG03.message, 401, MSG.MSG03.code);
  }

  // ── SyntaxError: Malformed JSON body ─────────────────────────────────
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return new AppError(MSG.MSG67.message, 400, MSG.MSG67.code);
  }

  // ── Unknown / Programming Error ───────────────────────────────────────
  return new AppError(
    process.env.NODE_ENV === 'production'
      ? MSG.MSG62.message
      : err.message || MSG.MSG62.message,
    500,
    MSG.MSG62.code
  );
};

// ── 404 Not Found Handler ──────────────────────────────────────────────────
/**
 * Catches requests to undefined routes and forwards a 404 AppError
 * to the main error handler below.
 * Register BEFORE errorHandler in app.js.
 */
export const notFoundHandler = (req, _res, next) => {
  next(
    new AppError(
      `Route ${req.method} ${req.originalUrl} not found.`,
      404,
      MSG.MSG61.code
    )
  );
};

// ── Global Error Handler ───────────────────────────────────────────────────
/**
 * @middleware errorHandler
 * The final error middleware in the Express chain.
 * Signature must include all 4 parameters to be recognized as an error handler.
 *
 * @param {Error} err
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export const errorHandler = (err, req, res, next) => { // eslint-disable-line no-unused-vars
  const normalized = normalizeError(err);

  // Log non-operational (programming) errors with full stack for debugging
  if (!normalized.isOperational || process.env.NODE_ENV === 'development') {
    console.error('💥 [Error]:', {
      method:     req.method,
      url:        req.originalUrl,
      statusCode: normalized.statusCode,
      code:       normalized.code,
      message:    normalized.message,
      stack:      process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    });
  }

  const response = {
    success: false,
    message: normalized.message,
    code:    normalized.code,
  };

  if (normalized.errors) {
    response.errors = normalized.errors;
  }

  // Include stack trace in development for faster debugging
  if (process.env.NODE_ENV === 'development' && err.stack) {
    response.stack = err.stack;
  }

  return res.status(normalized.statusCode).json(response);
};

export default { notFoundHandler, errorHandler };
