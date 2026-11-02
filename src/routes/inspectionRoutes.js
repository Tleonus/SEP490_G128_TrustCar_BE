// src/routes/inspectionRoutes.js
/**
 * @file inspectionRoutes.js
 * @description Routes for the CPO inspection workflow: digital checklist drafts
 * (staff), submit, upload signatures, admin quick-inspect and sale approval.
 */

import { Router } from 'express';
import * as inspectionController from '../controllers/inspectionController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { restrictTo } from '../middlewares/roleMiddleware.js';
import { validate, validateParams, objectIdParamSchema } from '../middlewares/validateMiddleware.js';
import { Roles } from '../constants/appConstants.js';
import { quickInspectSchema, updateDraftSchema } from './inspectionSchemas.js';

const router = Router();

// All inspection routes require valid authentication
router.use(verifyToken);

// Inspectors (and admins) fill in, submit and quick-inspect; sales staff may only read reports.
const INSPECTION_WRITERS = [Roles.INSPECTOR, Roles.ADMIN];
const INSPECTION_READERS = [Roles.INSPECTOR, Roles.ADMIN, Roles.SALES_STAFF];
const byId = validateParams(objectIdParamSchema);

// POST /api/v1/inspections/cars/:id/draft — start a draft for a car
router.post('/cars/:id/draft', restrictTo(...INSPECTION_WRITERS), byId, inspectionController.createDraft);

// POST /api/v1/inspections/cars/:id/inspect — quick inspection (5 booleans, no checklist)
router.post(
  '/cars/:id/inspect',
  restrictTo(...INSPECTION_WRITERS),
  byId,
  validate(quickInspectSchema),
  inspectionController.inspectCar
);

// POST /api/v1/inspections/cars/:id/upload-signature — signed upload for quick-inspection photos
router.post('/cars/:id/upload-signature', restrictTo(...INSPECTION_WRITERS), byId, inspectionController.createCarUploadSignature);

// PUT /api/v1/inspections/cars/:id/approve-sale (ADMIN only)
router.put(
  '/cars/:id/approve-sale',
  restrictTo(Roles.ADMIN),
  byId,
  inspectionController.approveSale
);

// GET /api/v1/inspections/:id — read a draft or a submitted record
router.get('/:id', restrictTo(...INSPECTION_READERS), byId, inspectionController.getInspection);

// PATCH /api/v1/inspections/:id — save part of a draft
router.patch('/:id', restrictTo(...INSPECTION_WRITERS), byId, validate(updateDraftSchema), inspectionController.updateDraft);

// POST /api/v1/inspections/:id/upload-signature — signed direct upload into this draft's folder
router.post('/:id/upload-signature', restrictTo(...INSPECTION_WRITERS), byId, inspectionController.createUploadSignature);

// POST /api/v1/inspections/:id/submit — validate, decide the CPO verdict and lock
router.post('/:id/submit', restrictTo(...INSPECTION_WRITERS), byId, inspectionController.submitInspection);

export default router;
