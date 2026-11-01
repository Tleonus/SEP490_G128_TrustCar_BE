// src/routes/inspectionRoutes.js
/**
 * @file inspectionRoutes.js
 * @description Routes for Car Inspection Workflow & Approval Engine (5 CPO Criteria).
 */

import { Router } from 'express';
import * as inspectionController from '../controllers/inspectionController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { restrictTo } from '../middlewares/roleMiddleware.js';
import { Roles } from '../constants/appConstants.js';

const router = Router();

// All inspection routes require valid authentication
router.use(verifyToken);

// API 1: POST /api/v1/inspections/cars/:id/inspect (INSPECTOR, ADMIN)
router.post(
  '/cars/:id/inspect',
  restrictTo(Roles.INSPECTOR, Roles.ADMIN),
  inspectionController.inspectCar
);

// API 2: PUT /api/v1/inspections/cars/:id/approve-sale (ADMIN only)
router.put(
  '/cars/:id/approve-sale',
  restrictTo(Roles.ADMIN),
  inspectionController.approveSale
);

export default router;

