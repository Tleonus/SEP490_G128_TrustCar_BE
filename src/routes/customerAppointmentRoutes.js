/**
 * @file customerAppointmentRoutes.js
 * @description Customer test-drive booking routes (/api/v1/customer/appointments).
 * Requires a logged-in CUSTOMER with a complete profile (verifyToken answers
 * PROFILE_INCOMPLETE otherwise); staff accounts get ROLE_INSUFFICIENT.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-001, 003…017)
 */

import { Router } from 'express';
import * as controller from '../controllers/customerAppointmentController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireRole } from '../middlewares/roleMiddleware.js';
import { validateParams, objectIdParamSchema } from '../middlewares/validateMiddleware.js';
import { Roles } from '../constants/appConstants.js';
import {
  validateBodyStrict, validateQueryStrict, createSchema, slotsQuery, customerListQuery, cancelSchema, rescheduleSchema,
} from './appointmentSchemas.js';

const router = Router();

router.use(verifyToken, requireRole(Roles.CUSTOMER));

/** @route GET /customer/appointments/slots?carIds=a,b&from=YYYY-MM-DD&to=YYYY-MM-DD[&excludeVisitId] (before /:id) */
router.get('/slots', validateQueryStrict(slotsQuery), controller.getSlots);

/** @route POST /customer/appointments  { carIds[1–3], scheduledAt (with offset), notes? } */
router.post('/', validateBodyStrict(createSchema), controller.createVisitHandler);

/** @route GET /customer/appointments?status&page&limit */
router.get('/', validateQueryStrict(customerListQuery), controller.listMine);

/** @route GET /customer/appointments/:id  (id of any appointment in the visit) */
router.get('/:id', validateParams(objectIdParamSchema), controller.getMine);

/** @route PATCH /customer/appointments/:id/cancel  { reason? } */
router.patch(
  '/:id/cancel',
  validateParams(objectIdParamSchema),
  validateBodyStrict(cancelSchema),
  controller.cancelMine,
);

/** @route PATCH /customer/appointments/:id/reschedule  { scheduledAt (with offset) } — 1.1.0 */
router.patch(
  '/:id/reschedule',
  validateParams(objectIdParamSchema),
  validateBodyStrict(rescheduleSchema),
  controller.rescheduleMine,
);

export default router;
