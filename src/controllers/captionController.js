/**
 * @file captionController.js
 * @description Marketing caption suggestions (KAN-68). Thin: validation lives in
 * the route schema, business rules in captionService.
 */

import * as captionService from '../services/captionService.js';
import { sendSuccess } from '../utils/apiResponse.js';

/**
 * @route  POST /api/v1/marketing/caption
 * @access Admin, Sales staff
 * @body   { carId, tone?, platform?, length? }
 * @desc   Three grounded caption options, hashtags and an image suggestion for a vehicle.
 */
export const suggestCaption = async (req, res, next) => {
  try {
    const { carId, tone, platform, length } = req.body;
    const result = await captionService.generateCaptions({
      carId,
      tone,
      platform,
      length,
      // verifyToken sets req.userId; req.user is a lean document, which has no `id` virtual.
      userId: req.userId,
    });
    return sendSuccess(res, 200, 'Caption suggestions generated successfully.', result);
  } catch (error) {
    next(error);
  }
};

export default { suggestCaption };
