/**
 * @file trackingController.js
 * @description HTTP controller cho POST /api/v1/track (KAN-97).
 */

import { recordInteraction } from '../services/trackingService.js';
import { sendSuccess } from '../utils/apiResponse.js';

export const track = async (req, res, next) => {
  try {
    const { sessionId, eventType, carId, metadata } = req.body;
    const result = await recordInteraction({
      sessionId: sessionId || null,
      customerId: req.user?.customer ? String(req.user.customer) : null,
      eventType,
      carId: carId || null,
      metadata: metadata || null,
    });
    return sendSuccess(res, 201, 'Interaction tracked.', result);
  } catch (error) { return next(error); }
};

export default { track };
