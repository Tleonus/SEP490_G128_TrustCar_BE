// src/routes/inspectionRoutes.js
/**
 * @file inspectionRoutes.js
 * @description Routes for the CPO inspection workflow: digital checklist drafts
 * (staff), submit, upload signatures, admin quick-inspect and sale approval.
 */

import { Router } from 'express';
import * as inspectionController from '../controllers/inspectionController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requirePermission } from '../middlewares/roleMiddleware.js';
import { validate, validateParams, objectIdParamSchema } from '../middlewares/validateMiddleware.js';
import { Permissions } from '../constants/appConstants.js';
import { quickInspectSchema, rejectInspectionSchema, updateDraftSchema } from './inspectionSchemas.js';

const router = Router();

// All inspection routes require valid authentication
router.use(verifyToken);

// KAN-94: access is granted through inspection permissions instead of a hard-coded
// role list, so a user holding only INSPECTOR (or SALES_STAFF + INSPECTOR) works too.
const canRead  = requirePermission(Permissions.INSPECTION_READ);
const canWrite = requirePermission(Permissions.INSPECTION_WRITE);
const canAdmin = requirePermission(Permissions.INSPECTION_ADMIN);

const byId = validateParams(objectIdParamSchema);

// POST /api/v1/inspections/cars/:id/draft — start a draft for a car
router.post('/cars/:id/draft', canWrite, byId, inspectionController.createDraft);

// POST /api/v1/inspections/cars/:id/inspect — quick inspection (5 booleans, no checklist)
router.post(
  '/cars/:id/inspect',
  canWrite,
  byId,
  validate(quickInspectSchema),
  inspectionController.inspectCar
);

// POST /api/v1/inspections/cars/:id/upload-signature — signed upload for quick-inspection photos
router.post('/cars/:id/upload-signature', canWrite, byId, inspectionController.createCarUploadSignature);

// PUT /api/v1/inspections/cars/:id/approve-sale (ADMIN only)
router.put(
  '/cars/:id/approve-sale',
  canAdmin,
  byId,
  inspectionController.approveSale
);

// GET /api/v1/inspections/:id — read a draft or a submitted record
router.get('/:id', canRead, byId, inspectionController.getInspection);

// PATCH /api/v1/inspections/:id — save part of a draft
router.patch('/:id', canWrite, byId, validate(updateDraftSchema), inspectionController.updateDraft);

// POST /api/v1/inspections/:id/upload-signature — signed direct upload into this draft's folder
router.post('/:id/upload-signature', canWrite, byId, inspectionController.createUploadSignature);

// POST /api/v1/inspections/:id/submit — validate, decide the CPO verdict and lock
router.post('/:id/submit', canWrite, byId, inspectionController.submitInspection);

// PUT /api/v1/inspections/:id/reject — ADMIN sends a submitted biên bản back
// to the sale staff for revision (KAN-53). Car status stays untouched.
router.put(
  '/:id/reject',
  canAdmin,
  byId,
  validate(rejectInspectionSchema),
  inspectionController.rejectInspection,
);

export default router;
