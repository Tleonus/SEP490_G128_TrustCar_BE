/**
 * @file serviceAppointmentRoutes.js
 * @description Customer service-appointment routes (KAN-96).
 *
 * Mounted at /api/v1/customer/appointments/service BEFORE the test-drive
 * router's `/:id` catch-all, otherwise "service" would be parsed as an id.
 * Guarded by the same verifyToken + CUSTOMER role check.
 */

import { Router } from 'express';
import * as controller from '../controllers/serviceAppointmentController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireRole } from '../middlewares/roleMiddleware.js';
import { validateParams, objectIdParamSchema } from '../middlewares/validateMiddleware.js';
import { Roles } from '../constants/appConstants.js';
import {
  validateBodyStrict, validateQueryStrict,
  createServiceAppointmentSchema, serviceSlotsQuery, serviceListQuery, cancelServiceSchema,
} from './appointmentSchemas.js';

const router = Router();

router.use(verifyToken, requireRole(Roles.CUSTOMER));

/** @route GET /customer/appointments/service/slots?from&to */
router.get('/slots', validateQueryStrict(serviceSlotsQuery), controller.getServiceSlots);

/** @route POST /customer/appointments/service */
router.post('/', validateBodyStrict(createServiceAppointmentSchema), controller.createService);

/** @route GET /customer/appointments/service?status&page&limit */
router.get('/', validateQueryStrict(serviceListQuery), controller.listMine);

/** @route PATCH /customer/appointments/service/:id/cancel */
router.patch(
  '/:id/cancel',
  validateParams(objectIdParamSchema),
  validateBodyStrict(cancelServiceSchema),
  controller.cancelMine,
);

export default router;
