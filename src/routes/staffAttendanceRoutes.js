/**
 * @file staffAttendanceRoutes.js
 * @description Staff attendance routes (/api/v1/staff-attendance). Reading and marking: ADMIN,
 * or a staff account an ADMIN allowed (`canTakeAttendance`). Granting that permission: ADMIN.
 */

import { Router } from 'express';
import Joi from 'joi';
import * as controller from '../controllers/staffAttendanceController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireRole } from '../middlewares/roleMiddleware.js';
import { validateParams } from '../middlewares/validateMiddleware.js';
import { Roles } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { AppError } from '../utils/apiResponse.js';
import { canTakeAttendance } from '../services/staffAttendanceService.js';
import { validateBodyStrict, validateQueryStrict } from './appointmentSchemas.js';

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/).lowercase().required();
const dateKey = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required();

const dayQuery = Joi.object({ date: dateKey });
const markParams = Joi.object({ date: dateKey, staffId: objectId });
const markBody = Joi.object({ present: Joi.boolean().strict().required() });
const keeperParams = Joi.object({ staffId: objectId });
const keeperBody = Joi.object({ enabled: Joi.boolean().strict().required() });

/** ADMIN, or a staff account allowed to take attendance. */
const requireAttendanceAccess = (req, _res, next) => {
  const isAdmin = (req.userRoleNames ?? []).includes(Roles.ADMIN);
  if (canTakeAttendance({ isAdmin, user: req.user })) return next();
  return next(new AppError(MSG.MSG94.message, MSG.MSG94.httpStatus, MSG.MSG94.code));
};

const router = Router();
router.use(verifyToken);

/** @route GET /staff-attendance?date=YYYY-MM-DD */
router.get('/', requireAttendanceAccess, validateQueryStrict(dayQuery), controller.getDay);

/** @route PATCH /staff-attendance/keepers/:staffId  { enabled } — ADMIN (before /:date/:staffId) */
router.patch('/keepers/:staffId', requireRole(Roles.ADMIN), validateParams(keeperParams), validateBodyStrict(keeperBody), controller.keeper);

/** @route PUT /staff-attendance/:date/:staffId  { present } */
router.put('/:date/:staffId', requireAttendanceAccess, validateParams(markParams), validateBodyStrict(markBody), controller.mark);

export default router;
