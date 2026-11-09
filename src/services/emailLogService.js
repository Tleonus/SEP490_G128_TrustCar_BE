/**
 * @file emailLogService.js
 * @description Records and lists email delivery attempts (KAN-39).
 *
 * Recording never throws: a logging failure must not turn a delivered email
 * into a failed one, nor hide the real send error from the caller.
 */

import EmailLog, { EmailStatus } from '../models/EmailLog.js';
import { AppError, parsePagination, buildPaginationMeta } from '../utils/apiResponse.js';
import logger from '../utils/logger.js';

const MASK = /[\w.+-]+@[\w.-]+/g;

/** j***@example.com. Anything that is not an address is stored unchanged. */
export const maskEmail = (email) => {
  const [local, domain] = String(email ?? '').split('@');
  if (!domain) return String(email ?? '');
  return `${local.charAt(0)}***@${domain}`;
};

/** Removes any address an SMTP reply may have echoed back. */
const scrub = (message) => (message ? String(message).replace(MASK, '[redacted]') : null);

/**
 * @param {{ to: string, subject?: string, transport: string, status: string, error?: string }} attempt
 * @returns {Promise<void>}
 */
export const recordEmailAttempt = async ({ to, subject, transport, status, error }) => {
  try {
    await EmailLog.create({
      toMasked: maskEmail(to),
      subject: subject || '',
      transport,
      status,
      error: scrub(error),
    });
  } catch (loggingError) {
    logger.error(`Email log write failed: ${loggingError.message}`);
  }
};

/**
 * Paginated delivery log for the admin screen.
 * @param {object} query
 * @returns {Promise<{ items: Array, pagination: object }>}
 */
export const listEmailLogs = async (query) => {
  const { page, limit, skip } = parsePagination(query);
  const filter = {};

  if (query.status) {
    const status = String(query.status).toUpperCase();
    if (!Object.values(EmailStatus).includes(status)) {
      throw new AppError(`Status must be one of: ${Object.values(EmailStatus).join(', ')}.`, 422, 'INVALID_STATUS');
    }
    filter.status = status;
  }

  const [items, total] = await Promise.all([
    EmailLog.find(filter).sort({ sentAt: -1 }).skip(skip).limit(limit).lean(),
    EmailLog.countDocuments(filter),
  ]);

  return { items, pagination: buildPaginationMeta(total, page, limit) };
};

export default { recordEmailAttempt, listEmailLogs, maskEmail };
