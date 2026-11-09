// src/controllers/inspectionController.js
/**
 * @file inspectionController.js
 * @description Controller for the CPO inspection workflow. Extracts request data,
 * calls the inspection services and formats responses; no business logic.
 */

import * as inspectionService from '../services/inspectionService.js';
import { sendSuccess } from '../utils/apiResponse.js';

/** Wraps an async handler so errors reach the global error middleware. */
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/v1/inspections/cars/:id/draft
 * @access  SALES_STAFF, ADMIN
 */
export const createDraft = handle(async (req, res) => {
  const record = await inspectionService.createDraft(req.params.id, req.userId);
  return sendSuccess(res, 201, 'Inspection draft created.', record);
});

/**
 * @route   PATCH /api/v1/inspections/:id
 * @access  SALES_STAFF, ADMIN
 */
export const updateDraft = handle(async (req, res) => {
  const record = await inspectionService.updateDraft(req.params.id, req.userId, req.body);
  return sendSuccess(res, 200, 'Inspection draft saved.', record);
});

/**
 * @route   GET /api/v1/inspections/:id
 * @access  SALES_STAFF, ADMIN, SALES_STAFF (read only)
 */
export const getInspection = handle(async (req, res) => {
  const record = await inspectionService.getInspection(req.params.id);
  return sendSuccess(res, 200, 'Inspection retrieved.', record);
});

/**
 * @route   POST /api/v1/inspections/:id/upload-signature
 * @access  SALES_STAFF, ADMIN
 */
export const createUploadSignature = handle(async (req, res) => {
  const signature = await inspectionService.createUploadSignature(req.params.id);
  return sendSuccess(res, 200, 'Upload signature issued.', signature);
});

/**
 * @route   POST /api/v1/inspections/cars/:id/upload-signature
 * @access  SALES_STAFF, ADMIN
 * @desc    Signature for uploading quick-inspection photos of a car.
 */
export const createCarUploadSignature = handle(async (req, res) => {
  const signature = await inspectionService.createCarUploadSignature(req.params.id);
  return sendSuccess(res, 200, 'Upload signature issued.', signature);
});

/**
 * @route   POST /api/v1/inspections/:id/submit
 * @access  SALES_STAFF, ADMIN
 * @desc    Validates the checklist, decides the CPO verdict and locks the record.
 */
export const submitInspection = handle(async (req, res) => {
  const result = await inspectionService.submitInspection(req.params.id, req.userId);
  return sendSuccess(res, 200, 'Inspection submitted.', result);
});

/**
 * @route   POST /api/v1/inspections/cars/:id/inspect
 * @access  SALES_STAFF, ADMIN
 * @desc    Quick inspection: 5 CPO booleans → APPROVED_CPO (with certificate) or REJECTED.
 */
export const inspectCar = handle(async (req, res) => {
  const result = await inspectionService.inspectCar(req.params.id, req.userId, req.userRole, req.body);
  return sendSuccess(res, 200, 'Inspection evaluated and recorded successfully.', result);
});

/**
 * @route   PUT /api/v1/inspections/cars/:id/approve-sale
 * @access  ADMIN only
 * @desc    Approves a CPO-certified car to become AVAILABLE on the public market.
 */
export const approveSale = handle(async (req, res) => {
  const car = await inspectionService.approveSale(req.params.id);
  return sendSuccess(res, 200, 'Car approved for sale successfully.', car);
});

export default {
  createDraft,
  updateDraft,
  getInspection,
  createUploadSignature,
  createCarUploadSignature,
  submitInspection,
  inspectCar,
  approveSale,
};
