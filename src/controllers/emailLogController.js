/**
 * @file emailLogController.js
 * @description Admin read access to the email delivery log (KAN-39).
 */

import * as emailLogService from '../services/emailLogService.js';
import { sendPaginated } from '../utils/apiResponse.js';

/**
 * @route  GET /api/v1/admin/email-logs
 * @access Admin
 */
export const listEmailLogs = async (req, res, next) => {
  try {
    const { items, pagination } = await emailLogService.listEmailLogs(req.query);
    return sendPaginated(res, 'Email logs retrieved successfully.', items, pagination);
  } catch (error) {
    next(error);
  }
};

export default { listEmailLogs };
