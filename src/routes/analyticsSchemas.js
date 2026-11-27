/**
 * @file analyticsSchemas.js
 * @description KAN-100 — Joi schema for GET /manage/analytics/overview.
 *
 * Accepts optional `from`/`to` ISO dates. When both omitted the service applies
 * a 180-day window (to = now, from = now - 180d). The schema enforces:
 *   - from < to when both are provided
 *   - the range is at most 365 days
 *
 * The validator always returns `{ from, to }` as JS Date objects so the service
 * layer does not have to re-parse them.
 */

import Joi from 'joi';

const MAX_RANGE_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 180;

export const analyticsOverviewQuery = Joi.object({
  from: Joi.date().iso().optional(),
  to:   Joi.date().iso().optional(),
})
  // Default + bounds-check happens in a custom step so we can emit one clean
  // message, rather than letting Joi fail with 'from must be less than to'.
  .custom((v, helpers) => {
    const now = new Date();
    const to  = v.to ? new Date(v.to) : now;
    const from = v.from
      ? new Date(v.from)
      : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
      return helpers.error('any.invalid', { message: '`from` is not a valid date' });
    }
    if (!(to instanceof Date) || Number.isNaN(to.getTime())) {
      return helpers.error('any.invalid', { message: '`to` is not a valid date' });
    }
    if (from >= to) {
      return helpers.error('range.inverted');
    }
    if (to - from > MAX_RANGE_MS) {
      return helpers.error('range.tooLarge');
    }
    return { from, to };
  })
  .messages({
    'range.inverted': '`from` must be earlier than `to`.',
    'range.tooLarge': 'Khoảng thời gian tối đa 365 ngày.',
  });

export default { analyticsOverviewQuery };
