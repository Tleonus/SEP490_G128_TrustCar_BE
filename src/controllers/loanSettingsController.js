/**
 * @file loanSettingsController.js
 * @description Loan calculator configuration controller (KAN-63).
 * Contains zero business logic; delegates to loanSettingsService.js.
 *
 * Routes handled:
 * - GET /api/v1/settings/loan → getLoanSettings (public)
 * - PUT /api/v1/settings/loan → updateLoanSettings (ADMIN only)
 */

import * as loanSettingsService from '../services/loanSettingsService.js';
import { sendSuccess } from '../utils/apiResponse.js';

/**
 * @route   GET /api/v1/settings/loan
 * @access  Public
 */
export const getLoanSettings = async (_req, res, next) => {
  try {
    const settings = await loanSettingsService.getLoanSettings();
    return sendSuccess(res, 200, 'Loan settings retrieved successfully.', settings);
  } catch (error) {
    return next(error);
  }
};

/**
 * @route   PUT /api/v1/settings/loan
 * @access  ADMIN only
 */
export const updateLoanSettings = async (req, res, next) => {
  try {
    const settings = await loanSettingsService.updateLoanSettings(req.body, req.userId);
    return sendSuccess(res, 200, 'Loan settings updated successfully.', settings);
  } catch (error) {
    return next(error);
  }
};

export default { getLoanSettings, updateLoanSettings };
