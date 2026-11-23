/**
 * @file carCompareController.js
 * @description Customer vehicle comparison controller.
 * Contains ZERO business logic; delegates to carCompareService.js.
 *
 * Routes handled:
 * - GET /api/v1/public/cars/compare   → compareCars (anyone, including guests)
 * - GET /api/v1/customer/cars/compare → compareCars (logged-in; kept for older clients)
 */

import * as carCompareService from '../services/carCompareService.js';
import * as carCompareAiService from '../services/carCompareAiService.js';
import { sendSuccess } from '../utils/apiResponse.js';

/**
 * @route   GET /api/v1/public/cars/compare?ids=a,b,c  (and /api/v1/customer/cars/compare)
 * @access  Public route: anyone. Customer route: any logged-in role (KAN-57); anonymous gets 401 there.
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

/**
 * @route   POST /api/v1/public/cars/compare/ai-insight
 * @access  Public (triggered on-demand when the user clicks "Gợi ý từ AI")
 * @body    { ids: string[] | string, preference?: 'overall'|'economy'|'performance'|'family'|'likenew' }
 * @desc    Returns a grounded AI quick analysis and situational recommendation with an AI disclaimer.
 */
export const getCompareAiInsight = async (req, res, next) => {
  try {
    const data = await carCompareAiService.generateCompareAiInsight({
      ids: req.body.ids,
      preference: req.body.preference,
    });
    return sendSuccess(res, 200, 'AI comparison insight generated successfully.', data);
  } catch (error) {
    next(error);
  }
};

export default { compareCars, getCompareAiInsight };
