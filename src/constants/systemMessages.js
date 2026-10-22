/**
 * @file systemMessages.js
 * @description Standardized error codes and messages (MSG01 – MSG68) for the
 * TrustCar platform. All API error responses reference these codes to enable
 * consistent front-end handling and support ticket correlation.
 *
 * Structure per message:
 *   code:       Short machine-readable identifier (e.g., 'INVALID_TOKEN')
 *   message:    Human-readable description (English; Vietnamese can be added in i18n layer)
 *   httpStatus: Recommended HTTP status code for this error
 *
 * Usage:
 *   import { SystemMessages as MSG } from '../constants/systemMessages.js';
 *   throw new AppError(MSG.MSG02.message, MSG.MSG02.httpStatus, MSG.MSG02.code);
 */

export const SystemMessages = Object.freeze({

  // ════════════════════════════════════════════════════════════════════════════
  // AUTH – MSG01 to MSG15
  // ════════════════════════════════════════════════════════════════════════════
  MSG01: { code: 'TOKEN_MISSING',        message: 'Authorization token is missing.',                         httpStatus: 401 },
  MSG02: { code: 'TOKEN_EXPIRED',        message: 'Authorization token has expired. Please log in again.',   httpStatus: 401 },
  MSG03: { code: 'TOKEN_INVALID',        message: 'Authorization token is invalid or malformed.',            httpStatus: 401 },
  MSG04: { code: 'FORBIDDEN',            message: 'You do not have permission to perform this action.',      httpStatus: 403 },
  MSG05: { code: 'ROLE_INSUFFICIENT',    message: 'Your current role does not grant access to this resource.', httpStatus: 403 },
  MSG06: { code: 'ACCOUNT_INACTIVE',     message: 'Your account has been deactivated. Contact an administrator.', httpStatus: 401 },
  MSG07: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.',                         httpStatus: 401 },
  MSG08: { code: 'EMAIL_NOT_FOUND',      message: 'No account is registered with this email address.',       httpStatus: 404 },
  MSG09: { code: 'LOGOUT_SUCCESS',       message: 'You have been logged out successfully.',                  httpStatus: 200 },
  MSG10: { code: 'ACCOUNT_LOCKED',       message: 'Account is locked due to too many failed login attempts. Try again in 30 minutes.', httpStatus: 423 },
  MSG11: { code: 'LOGIN_ATTEMPT_WARN',   message: 'Invalid credentials. Account will be locked after {remaining} more failed attempt(s).', httpStatus: 401 },
  MSG12: { code: 'WEAK_PASSWORD',        message: 'Password must be at least 8 characters and include uppercase, lowercase, digit, and special character.', httpStatus: 422 },
  MSG13: { code: 'PASSWORD_SAME',        message: 'New password must be different from the current password.', httpStatus: 422 },
  MSG14: { code: 'RESET_TOKEN_INVALID',  message: 'Password reset token is invalid or has expired.',         httpStatus: 400 },
  MSG15: { code: 'REFRESH_TOKEN_INVALID', message: 'Refresh token is invalid or has expired.',               httpStatus: 401 },

  // ════════════════════════════════════════════════════════════════════════════
  // USER MANAGEMENT – MSG16 to MSG19
  // ════════════════════════════════════════════════════════════════════════════
  MSG16: { code: 'SELF_DEACTIVATE',      message: 'You cannot deactivate your own account.',                 httpStatus: 400 },
  MSG17: { code: 'USER_NOT_FOUND',        message: 'User account not found.',                                 httpStatus: 404 },
  MSG18: { code: 'EMAIL_ALREADY_EXISTS', message: 'An account with this email address already exists.',      httpStatus: 409 },
  MSG19: { code: 'USER_ALREADY_ACTIVE',  message: 'This user account is already active.',                    httpStatus: 409 },

  // ════════════════════════════════════════════════════════════════════════════
  // VEHICLE / CAR INVENTORY – MSG20 to MSG29
  // ════════════════════════════════════════════════════════════════════════════
  MSG20: { code: 'VIN_DUPLICATE',        message: 'A vehicle with this VIN already exists in the system.',   httpStatus: 409 },
  MSG21: { code: 'STATUS_TRANSITION_INVALID', message: 'This status transition is not permitted by the vehicle lifecycle rules.', httpStatus: 422 },
  MSG22: { code: 'STATUS_TERMINAL',      message: 'This vehicle is in a terminal state and cannot be transitioned.',              httpStatus: 422 },
  MSG23: { code: 'VEHICLE_SOLD_LOCKED',  message: 'Sold vehicles are read-only and cannot be modified.',     httpStatus: 403 },
  MSG24: { code: 'PRICE_HISTORY_IMMUTABLE', message: 'Price history entries cannot be modified or deleted.', httpStatus: 403 },
  MSG25: { code: 'PLATE_DUPLICATE',      message: 'A vehicle with this license plate is already active in inventory.', httpStatus: 409 },
  MSG26: { code: 'MILEAGE_DECREASED',    message: 'Odometer reading cannot be lower than the current recorded value.', httpStatus: 422 },
  MSG27: { code: 'INVALID_YEAR',         message: 'Production year must be between 1990 and next year.',     httpStatus: 422 },
  MSG28: { code: 'MULTIPLE_PRIMARY_IMAGES', message: 'Only one image can be marked as primary.',              httpStatus: 422 },
  MSG29: { code: 'IMAGE_LIMIT_EXCEEDED', message: 'A vehicle can have a maximum of 20 images.',              httpStatus: 422 },

  // ════════════════════════════════════════════════════════════════════════════
  // CUSTOMER – MSG30 to MSG31
  // ════════════════════════════════════════════════════════════════════════════
  MSG30: { code: 'PHONE_DUPLICATE_WARN', message: 'A customer with this phone number already exists.',        httpStatus: 200 },
  MSG31: { code: 'CUSTOMER_NOT_FOUND',   message: 'Customer record not found.',                              httpStatus: 404 },

  // ════════════════════════════════════════════════════════════════════════════
  // LEAD / CRM – MSG32 to MSG34
  // ════════════════════════════════════════════════════════════════════════════
  MSG32: { code: 'LEAD_STAGE_INVALID',   message: 'Lead stage transition is not permitted by the pipeline rules.', httpStatus: 422 },
  MSG33: { code: 'LEAD_NOT_FOUND',       message: 'Lead record not found.',                                   httpStatus: 404 },
  MSG34: { code: 'LEAD_CODE_GENERATE_FAIL', message: 'Failed to generate a unique lead code. Please retry.', httpStatus: 500 },

  // ════════════════════════════════════════════════════════════════════════════
  // APPOINTMENTS – MSG35 to MSG39
  // ════════════════════════════════════════════════════════════════════════════
  MSG35: { code: 'APPOINTMENT_TOO_SOON', message: 'Appointments must be scheduled at least 2 hours in advance.', httpStatus: 422 },
  MSG36: { code: 'APPOINTMENT_TOO_FAR',  message: 'Appointments cannot be scheduled more than 60 days in advance.', httpStatus: 422 },
  MSG37: { code: 'APPOINTMENT_CONFLICT', message: 'This vehicle already has a pending/confirmed appointment within the same time window.', httpStatus: 409 },
  MSG38: { code: 'APPOINTMENT_NOT_FOUND', message: 'Appointment record not found.',                           httpStatus: 404 },
  MSG39: { code: 'APPOINTMENT_CANCELLED_ALREADY', message: 'This appointment has already been cancelled.',    httpStatus: 409 },

  // ════════════════════════════════════════════════════════════════════════════
  // AUDIT & COMPLIANCE – MSG40 to MSG41
  // ════════════════════════════════════════════════════════════════════════════
  MSG40: { code: 'AUDIT_LOG_WRITE_FAIL', message: 'Failed to write audit log entry. Operation rolled back.', httpStatus: 500 },
  MSG41: { code: 'HARD_DELETE_FORBIDDEN', message: 'Hard deletion is not permitted. Records are soft-deleted only.', httpStatus: 403 },

  // ════════════════════════════════════════════════════════════════════════════
  // INPUT VALIDATION – MSG42 to MSG55
  // ════════════════════════════════════════════════════════════════════════════
  MSG42: { code: 'VALIDATION_ERROR',     message: 'Request validation failed.',                               httpStatus: 422 },
  MSG43: { code: 'REQUIRED_FIELD',       message: 'One or more required fields are missing.',                 httpStatus: 422 },
  MSG44: { code: 'INVALID_VIN',          message: 'VIN must be exactly 17 alphanumeric characters (ISO 3779).', httpStatus: 422 },
  MSG45: { code: 'INVALID_PLATE',        message: 'License plate format is invalid. Must match Vietnamese plate format.', httpStatus: 422 },
  MSG46: { code: 'INVALID_PHONE',        message: 'Phone number must be a valid Vietnamese 10-digit number (0xxxxxxxxx).', httpStatus: 422 },
  MSG47: { code: 'INVALID_EMAIL',        message: 'Email address format is invalid.',                         httpStatus: 422 },
  MSG48: { code: 'INVALID_PRICE',        message: 'Price must be a positive number.',                         httpStatus: 422 },
  MSG49: { code: 'INVALID_MILEAGE',      message: 'Mileage must be a non-negative integer.',                  httpStatus: 422 },
  MSG50: { code: 'INVALID_PAGINATION',   message: 'Page and limit must be positive integers.',                httpStatus: 422 },
  MSG51: { code: 'INVALID_DATE',         message: 'Date format is invalid. Use ISO 8601 (YYYY-MM-DDTHH:mm:ssZ).', httpStatus: 422 },
  MSG52: { code: 'INVALID_ENUM',         message: 'Provided value is not a valid option for this field.',     httpStatus: 422 },
  MSG53: { code: 'FIELD_TOO_LONG',       message: 'One or more fields exceed the maximum allowed length.',    httpStatus: 422 },
  MSG54: { code: 'INVALID_OBJECT_ID',    message: 'Provided ID is not a valid resource identifier.',          httpStatus: 422 },
  MSG55: { code: 'INVALID_YEAR_RANGE',   message: 'Year range filter is invalid. Min year must be ≤ max year.', httpStatus: 422 },

  // ════════════════════════════════════════════════════════════════════════════
  // FILE UPLOAD – MSG56 to MSG60
  // ════════════════════════════════════════════════════════════════════════════
  MSG56: { code: 'NO_FILE_UPLOADED',     message: 'No file was included in the request.',                     httpStatus: 400 },
  MSG57: { code: 'FILE_TOO_LARGE',       message: 'File size exceeds the 5 MB limit.',                       httpStatus: 413 },
  MSG58: { code: 'INVALID_FILE_TYPE',    message: 'Only JPEG, PNG, and WebP image files are accepted.',       httpStatus: 415 },
  MSG59: { code: 'UPLOAD_FAILED',        message: 'Image upload to cloud storage failed. Please try again.',  httpStatus: 502 },
  MSG60: { code: 'IMAGE_NOT_FOUND',      message: 'Image with the specified identifier was not found on this vehicle.', httpStatus: 404 },

  // ════════════════════════════════════════════════════════════════════════════
  // GENERAL / SYSTEM – MSG61 to MSG68
  // ════════════════════════════════════════════════════════════════════════════
  MSG61: { code: 'NOT_FOUND',            message: 'The requested resource was not found.',                    httpStatus: 404 },
  MSG62: { code: 'INTERNAL_ERROR',       message: 'An unexpected server error occurred. Please try again later.', httpStatus: 500 },
  MSG63: { code: 'SERVICE_UNAVAILABLE',  message: 'The service is temporarily unavailable. Please try again.', httpStatus: 503 },
  MSG64: { code: 'RATE_LIMIT_EXCEEDED',  message: 'Too many requests. Please slow down and try again later.', httpStatus: 429 },
  MSG65: { code: 'DB_CONNECTION_ERROR',  message: 'Database connection is unavailable.',                      httpStatus: 503 },
  MSG66: { code: 'DUPLICATE_KEY',        message: 'A record with this unique value already exists.',          httpStatus: 409 },
  MSG67: { code: 'INVALID_REQUEST',      message: 'The request is malformed or contains invalid JSON.',       httpStatus: 400 },
  MSG68: { code: 'OPERATION_NOT_ALLOWED', message: 'This operation is not allowed in the current context.',   httpStatus: 405 },
});

export default SystemMessages;
