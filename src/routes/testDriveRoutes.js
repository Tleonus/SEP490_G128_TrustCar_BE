/**
 * @file testDriveRoutes.js
 * @description Test-drive API (/api/v1/test-drives). Every route needs a signed-in
 * account; verifyToken also refuses customers with an incomplete profile.
 *
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-018
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as controller from '../controllers/testDriveController.js';
import { Roles, TEST_DRIVE_LIMITS } from '../constants/appConstants.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireRole } from '../middlewares/roleMiddleware.js';
import { objectIdParamSchema, validate, validateParams, validateQuery } from '../middlewares/validateMiddleware.js';
import { sendError } from '../utils/apiResponse.js';
import {
  assignSchema, bookSchema, carSlotsParamsSchema, carSlotsQuerySchema, listMineQuerySchema, listQuerySchema, outcomeSchema, staffCancelSchema,
} from './testDriveSchemas.js';

const router = Router();

const customerOnly = requireRole(Roles.CUSTOMER);
const staffOnly = requireRole(Roles.SALES_STAFF, Roles.ADMIN);
const anyRole = requireRole(Roles.CUSTOMER, Roles.SALES_STAFF, Roles.ADMIN);
const byId = validateParams(objectIdParamSchema);

// Counted per account, so it must run after verifyToken.
const bookingLimiter = rateLimit({
  windowMs: TEST_DRIVE_LIMITS.BOOKING_RATE_WINDOW_MS,
  max: TEST_DRIVE_LIMITS.BOOKING_RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId,
  handler: (_req, res) => sendError(res, 429, 'Too many booking requests. Please try again later.', 'TOO_MANY_REQUESTS'),
});

router.use(verifyToken);

router.get('/cars/:carId/slots', anyRole, validateParams(carSlotsParamsSchema), validateQuery(carSlotsQuerySchema), controller.getCarSlots);

// ── Customer ───────────────────────────────────────────────────────────────
router.post('/', customerOnly, bookingLimiter, validate(bookSchema), controller.book);
router.get('/me', customerOnly, validateQuery(listMineQuerySchema), controller.listMine);
router.post('/:id/cancel', customerOnly, byId, controller.cancelMine);

// ── Staff ──────────────────────────────────────────────────────────────────
router.get('/', staffOnly, validateQuery(listQuerySchema), controller.list);
router.get('/staff', staffOnly, controller.listStaff);
router.patch('/:id/assign', staffOnly, byId, validate(assignSchema), controller.assign);
router.post('/:id/confirm', staffOnly, byId, controller.confirm);
router.post('/:id/staff-cancel', staffOnly, byId, validate(staffCancelSchema), controller.staffCancel);
router.post('/:id/complete', staffOnly, byId, validate(outcomeSchema), controller.complete);
router.post('/:id/no-show', staffOnly, byId, controller.noShow);
router.post('/:id/correct-no-show', requireRole(Roles.ADMIN), byId, validate(outcomeSchema), controller.correctNoShow);

export default router;
