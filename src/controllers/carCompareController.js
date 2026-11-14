/**
 * @file carCompareController.js
 * @description Customer vehicle comparison controller.
 * Contains ZERO business logic; delegates to carCompareService.js.
 *
 * Routes handled:
 * - GET /api/v1/customer/cars/compare → compareCars
 */

import * as carCompareService from '../services/carCompareService.js';
import { sendSuccess } from '../utils/apiResponse.js';

/**
 * @route   GET /api/v1/customer/cars/compare?ids=a,b,c
 * @access  Any logged-in role (KAN-57). Anonymous callers get 401.
 * @query   ids – 2 to 3 distinct vehicle _id values (already normalised to an array by validateQuery)
 * @desc    Returns the allow-listed public attributes of the selected AVAILABLE vehicles
 *          side by side, plus the ids that are no longer available.
 *
 * @ears .sdd/features/vehicle-comparison/SPEC.md#REQ-009
 */
export const compareCars = async (req, res, next) => {
  try {
    const data = await carCompareService.compareCars(req.query.ids);
    return sendSuccess(res, 200, 'Vehicle comparison retrieved successfully.', data);
  } catch (error) {
    next(error);
  }
};

export default { compareCars };
