/**
 * @file uploadMiddleware.js
 * @description Multer file upload middleware for vehicle images.
 *
 * Uses memoryStorage so file buffers can be piped directly to Cloudinary
 * without writing to disk (stateless, works in serverless / containerized envs).
 *
 * Enforces at the transport layer (before reaching Cloudinary):
 * - Max file size: 5 MB per file (Ref: MSG57)
 * - Accepted MIME types: image/jpeg, image/png, image/webp (Ref: MSG58)
 * - Max files per request: configurable (default 10; max per car = 20 via GBR-15)
 *
 * Ref: GBR-14, GBR-15, MSG56, MSG57, MSG58
 */

import multer from 'multer';
import { AppError } from '../utils/apiResponse.js';
import { UPLOAD } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';

// ── Storage: Memory (no disk I/O) ──────────────────────────────────────────
const storage = multer.memoryStorage();

// ── File Filter ────────────────────────────────────────────────────────────
/**
 * Validates MIME type of incoming files.
 * Rejects anything that isn't JPEG, PNG, or WebP.
 * Ref: MSG58
 */
const fileFilter = (_req, file, cb) => {
  if (UPLOAD.ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new AppError(MSG.MSG58.message, MSG.MSG58.httpStatus, MSG.MSG58.code),
      false
    );
  }
};

// ── Multer Instance ────────────────────────────────────────────────────────
const multerUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: UPLOAD.MAX_FILE_SIZE_BYTES, // 5 MB per file
    files:    10,                          // Max 10 files per request batch
  },
});

// ── Error Handler Wrapper ──────────────────────────────────────────────────
/**
 * Wraps a Multer upload handler to catch MulterError and convert to AppError.
 * @param {Function} uploadFn - A multer upload function (e.g., multerUpload.array(...))
 * @returns {import('express').RequestHandler}
 */
const wrapMulter = (uploadFn) => (req, res, next) => {
  uploadFn(req, res, (err) => {
    if (!err) return next();

    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError(MSG.MSG57.message, MSG.MSG57.httpStatus, MSG.MSG57.code));
    }

    if (err.code === 'LIMIT_FILE_COUNT') {
      return next(
        new AppError(
          'Too many files uploaded in one request. Maximum is 10 files per upload.',
          422,
          'FILE_COUNT_EXCEEDED'
        )
      );
    }

    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(
        new AppError(
          `Unexpected field: "${err.field}". Use the correct file field name.`,
          400,
          'UNEXPECTED_FIELD'
        )
      );
    }

    if (err instanceof AppError) return next(err);

    // Generic Multer or unknown error
    next(new AppError(MSG.MSG59.message, MSG.MSG59.httpStatus, MSG.MSG59.code));
  });
};

// ── Exported Middleware Variants ───────────────────────────────────────────

/**
 * Single file upload under the field name "image".
 * Used for: avatar updates, single-image operations.
 */
export const uploadSingle = wrapMulter(multerUpload.single('image'));

/**
 * Multiple file upload under the field name "images".
 * Used for: vehicle image batch upload.
 * @param {number} [maxCount=10]
 */
export const uploadMultiple = (maxCount = 10) =>
  wrapMulter(multerUpload.array('images', maxCount));

/**
 * Field-based upload supporting mixed fields.
 * @param {Array<{name: string, maxCount: number}>} fields
 */
export const uploadFields = (fields) =>
  wrapMulter(multerUpload.fields(fields));

/**
 * Validates that at least one file was uploaded.
 * Place after uploadSingle / uploadMultiple to enforce file presence.
 * Ref: MSG56
 */
export const requireFile = (req, _res, next) => {
  const hasFile  = req.file || (req.files && req.files.length > 0);
  if (!hasFile) {
    return next(new AppError(MSG.MSG56.message, MSG.MSG56.httpStatus, MSG.MSG56.code));
  }
  next();
};

export default { uploadSingle, uploadMultiple, uploadFields, requireFile };
