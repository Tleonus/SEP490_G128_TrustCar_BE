/**
 * @file activityLogController.js
 * @description Admin read access to the activity log (KAN-40). ZERO business logic; delegates to
 * activityLogService. Mounted under /api/v1/admin.
 *
 * Routes handled:
 * - GET /activity-logs        → list
 * - GET /activity-logs/meta   → meta
 * - GET /activity-logs/:id    → getOne
 *
 * Ref: .sdd/features/system-audit-logs/SPEC.md (REQ-001…010)
 */

import { getActivityLog, getActivityLogMeta, listActivityLogs } from '../services/activityLogService.js';
import { sendPaginated, sendSuccess } from '../utils/apiResponse.js';

/** @route GET /api/v1/admin/activity-logs  @access Admin */
export const list = async (req, res, next) => {
  try {
    const { items, pagination } = await listActivityLogs(req.query);
    return sendPaginated(res, 'Activity logs retrieved successfully.', items, pagination);
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/v1/admin/activity-logs/meta  @access Admin */
export const meta = async (req, res, next) => {
  try {
    return sendSuccess(res, 200, 'Activity log filters retrieved successfully.', await getActivityLogMeta());
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/v1/admin/activity-logs/:id  @access Admin */
export const getOne = async (req, res, next) => {
  try {
    return sendSuccess(res, 200, 'Activity log retrieved successfully.', await getActivityLog(req.params.id));
  } catch (error) {
    return next(error);
  }
};

export default { list, meta, getOne };
