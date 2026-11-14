/**
 * @file appointmentRoutes.js
 * @description Staff test-drive appointment routes (/api/v1/appointments).
 * Needs `appointment:read` (list/read/slots), `appointment:update` (status change, reschedule)
 * or `appointment:create` (search customers, book on behalf):
 * granted to ADMIN and SALES_STAFF only.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-002, 018…021)
 */

import { Router } from 'express';
import * as controller from '../controllers/appointmentController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requirePermission } from '../middlewares/roleMiddleware.js';
import { validateParams, objectIdParamSchema } from '../middlewares/validateMiddleware.js';
import { Permissions } from '../constants/appConstants.js';
import {
  validateBodyStrict, validateQueryStrict, staffListQuery, statusSchema,
  rescheduleSchema, staffSlotsQuery, customerSearchQuery, staffCreateSchema,
} from './appointmentSchemas.js';

const router = Router();

router.use(verifyToken);

/** @route GET /appointments?status&carId&from&to&cancellationType&page&limit */
router.get(
  '/',
  requirePermission(Permissions.APPOINTMENT_READ),
  validateQueryStrict(staffListQuery),
  controller.list,
);

/** @route GET /appointments/slots?from&to[&carIds][&excludeVisitId] — who is booked where (1.1.0; before /:id) */
router.get(
  '/slots',
  requirePermission(Permissions.APPOINTMENT_READ),
  validateQueryStrict(staffSlotsQuery),
  controller.slots,
);

/** @route GET /appointments/customers?q=  — find a customer to book for (1.1.0; before /:id) */
router.get(
  '/customers',
  requirePermission(Permissions.APPOINTMENT_CREATE),
  validateQueryStrict(customerSearchQuery),
  controller.customers,
);

/** @route POST /appointments  { customerId, carIds[1–3], scheduledAt (with offset), notes? } — book on behalf (1.1.0) */
router.post(
  '/',
  requirePermission(Permissions.APPOINTMENT_CREATE),
  validateBodyStrict(staffCreateSchema),
  controller.createForCustomer,
);

/** @route GET /appointments/:id */
router.get(
  '/:id',
  requirePermission(Permissions.APPOINTMENT_READ),
  validateParams(objectIdParamSchema),
  controller.getOne,
);

/** @route PATCH /appointments/:id/status  { status, reason?, outcome? } */
router.patch(
  '/:id/status',
  requirePermission(Permissions.APPOINTMENT_UPDATE),
  validateParams(objectIdParamSchema),
  validateBodyStrict(statusSchema),
  controller.changeStatus,
);

/** @route PATCH /appointments/:id/reschedule  { scheduledAt (with offset) } — 1.1.0 */
router.patch(
  '/:id/reschedule',
  requirePermission(Permissions.APPOINTMENT_UPDATE),
  validateParams(objectIdParamSchema),
  validateBodyStrict(rescheduleSchema),
  controller.reschedule,
);

export default router;
