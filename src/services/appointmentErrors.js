/**
 * @file appointmentErrors.js
 * @description Tiny helper that turns a SystemMessages entry into an AppError,
 * shared by the appointment services (keeps each service free of boilerplate).
 */

import { AppError } from '../utils/apiResponse.js';

/**
 * @param {{code: string, message: string, httpStatus: number}} msg - Entry of SystemMessages.
 * @param {object|Array|null} [errors] - Optional detail (e.g. `{ carIds: [...] }`).
 * @returns {AppError}
 */
export const fail = (msg, errors = null) =>
  new AppError(msg.message, msg.httpStatus, msg.code, errors);

export default { fail };
