/**
 * @file analyticsController.js
 * @description KAN-100 — thin HTTP wrapper around analyticsService.
 */

import * as analyticsService from '../services/analyticsService.js';
import { sendSuccess } from '../utils/apiResponse.js';

/**
 * @route   GET /api/v1/manage/analytics/overview
 * @access  Admin only
 * @query   { from?: Date, to?: Date }   (populated by Joi validator)
 */
export const getOverview = async (req, res, next) => {
  try {
    // validateQueryStrict has replaced req.query with the custom-validated
    // output: `{ from: Date, to: Date }`.
    const { from, to } = req.query;
    const data = await analyticsService.getOverview({ from, to });
    return sendSuccess(res, 200, 'Analytics overview loaded.', data);
  } catch (error) {
    next(error);
  }
};

export default { getOverview };
