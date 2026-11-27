/**
 * @file staffAttendanceController.js
 * @description Staff attendance ("điểm danh") for test-drive staffing. No business logic.
 *
 * Routes (/api/v1/staff-attendance):
 * - GET   /?date=YYYY-MM-DD        → getDay
 * - PUT   /:date/:staffId          → mark   { present }
 * - PATCH /keepers/:staffId        → keeper { enabled }   (ADMIN)
 */

import { getAttendance, setPresence, setAttendanceKeeper } from '../services/staffAttendanceService.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { Roles } from '../constants/appConstants.js';

const isAdmin = (req) => (req.userRoleNames ?? []).includes(Roles.ADMIN);

export const getDay = async (req, res, next) => {
  try {
    const data = await getAttendance({ date: req.query.date });
    return sendSuccess(res, 200, 'Attendance retrieved successfully.', { ...data, canManageKeepers: isAdmin(req) });
  } catch (error) {
    return next(error);
  }
};

export const mark = async (req, res, next) => {
  try {
    const data = await setPresence({
      date: req.params.date, staffId: req.params.staffId, present: req.body.present, userId: req.userId, ipAddress: req.ip,
    });
    return sendSuccess(res, 200, 'Attendance updated successfully.', data);
  } catch (error) {
    return next(error);
  }
};

export const keeper = async (req, res, next) => {
  try {
    const data = await setAttendanceKeeper({
      staffId: req.params.staffId, enabled: req.body.enabled, userId: req.userId, ipAddress: req.ip,
    });
    return sendSuccess(res, 200, 'Attendance permission updated successfully.', data);
  } catch (error) {
    return next(error);
  }
};

export default { getDay, mark, keeper };
