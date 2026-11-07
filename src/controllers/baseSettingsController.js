import * as baseSettingsService from '../services/baseSettingsService.js';
import { sendSuccess } from '../utils/apiResponse.js';

export const getBaseSettings = async (_req, res, next) => {
  try {
    const settings = await baseSettingsService.getBaseSettings();
    return sendSuccess(res, 200, 'Showroom settings retrieved successfully.', settings);
  } catch (error) {
    return next(error);
  }
};

export const updateBaseSettings = async (req, res, next) => {
  try {
    const settings = await baseSettingsService.updateBaseSettings(req.body, req.userId);
    return sendSuccess(res, 200, 'Showroom settings updated successfully.', settings);
  } catch (error) {
    return next(error);
  }
};

export default { getBaseSettings, updateBaseSettings };
