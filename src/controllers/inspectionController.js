// src/controllers/inspectionController.js
/**
 * @file inspectionController.js
 * @description Controller for Car Inspection Workflow & Approval Engine (5 CPO Criteria).
 */

import * as inspectionService from '../services/inspectionService.js';
import { sendSuccess } from '../utils/apiResponse.js';

/**
 * @route   POST /api/v1/inspections/cars/:id/inspect
 * @access  INSPECTOR, ADMIN
 * @desc    Evaluates 5 CPO criteria, updates car status (APPROVED_CPO or REJECTED),
 *          generates CPO certificate if passed, and logs inspection record.
 */
export const inspectCar = async (req, res, next) => {
  try {
    const { id } = req.params;
    const inspectorId = req.userId;
    const result = await inspectionService.inspectCar(id, inspectorId, req.body);
    return sendSuccess(res, 200, 'Inspection evaluated and recorded successfully.', result);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PUT /api/v1/inspections/cars/:id/approve-sale
 * @access  ADMIN only
 * @desc    Approves a CPO-certified car to become AVAILABLE on the public market.
 */
export const approveSale = async (req, res, next) => {
  try {
    const { id } = req.params;
    const car = await inspectionService.approveSale(id);
    return sendSuccess(res, 200, 'Car approved for sale successfully.', car);
  } catch (error) {
    next(error);
  }
};

export default {
  inspectCar,
  approveSale,
};

