/**
 * @file trackSchemas.js
 * @description KAN-97 — Joi schema cho POST /api/v1/track.
 *
 * Body strict: tham số lạ 422. `carId` bắt buộc với VIEW_CAR / WISHLIST_ADD /
 * COMPARE_ADD (không có xe thì event vô nghĩa cho chấm điểm).
 */

import Joi from 'joi';
import { TRACKABLE_EVENT_TYPES, CAR_REQUIRED_EVENT_TYPES } from '../constants/leadScoringConstants.js';

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/).messages({
  'string.pattern.base': 'ID phải là chuỗi ObjectId 24 ký tự hex.',
});

export const trackEventSchema = Joi.object({
  sessionId: objectId.allow(null, ''),
  eventType: Joi.string().valid(...TRACKABLE_EVENT_TYPES).required(),
  carId: Joi.when('eventType', {
    is: Joi.string().valid(...CAR_REQUIRED_EVENT_TYPES),
    then: objectId.required(),
    otherwise: objectId.allow(null, ''),
  }),
  metadata: Joi.object().max(20).custom((value, helpers) => {
    try {
      if (JSON.stringify(value).length > 1024) return helpers.message('metadata must be at most 1 KB.');
    } catch {
      return helpers.message('metadata is not JSON-serialisable.');
    }
    return value;
  }).allow(null),
}).unknown(false);

export default { trackEventSchema };
