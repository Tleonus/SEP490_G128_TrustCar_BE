/**
 * @file activityLogSchemas.js
 * @description Joi schema of the admin activity-log list query (KAN-40). Used with the strict
 * query validator of `appointmentSchemas.js`, so unknown or empty parameters answer 422 VALIDATION_ERROR
 * before any database access.
 *
 * Ref: .sdd/features/system-audit-logs/SPEC.md (REQ-005; C3, C4, C6; AC-08)
 */

import Joi from 'joi';
import { ActivityEventType } from '../constants/appConstants.js';
import { parseDateKey } from '../services/appointmentSlotRules.js';

const TEXT_MAX = 200;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const text = Joi.string().trim().min(1).max(TEXT_MAX);

/** `YYYY-MM-DD` that exists on the calendar (2026-02-30 is rejected). */
const realDay = (value, helpers) => (parseDateKey(value) ? value : helpers.error('any.invalid'));
const day = Joi.string().pattern(DATE_KEY).custom(realDay, 'real calendar date');

/** `to` must not be before `from` (the error is attached to `to`). */
const notBeforeFrom = (value, helpers) => {
  const { from } = helpers.state.ancestors[0];
  return typeof from === 'string' && from > value ? helpers.message('to must not be before from') : value;
};

/**
 * @ears .sdd/features/system-audit-logs/SPEC.md#REQ-005
 */
export const listQuery = Joi.object({
  eventType: Joi.string().valid(...Object.values(ActivityEventType)),
  targetModel: text,
  targetId: Joi.string().pattern(OBJECT_ID).lowercase(),
  targetCode: text,
  actorEmail: text,
  from: day,
  to: day.custom(notBeforeFrom, 'not before from'),
  sort: Joi.string().valid('asc', 'desc'),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
});

export default { listQuery };
