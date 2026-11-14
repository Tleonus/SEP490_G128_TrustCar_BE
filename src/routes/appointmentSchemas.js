/**
 * @file appointmentSchemas.js
 * @description Joi schemas and STRICT validators for the test-drive booking routes.
 *
 * The shared `validate` middleware strips unknown fields silently; the Spec (REQ-004)
 * requires 422 for unknown fields, so these validators reject them instead.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-004, section 5)
 */

import Joi from 'joi';
import { sendError } from '../utils/apiResponse.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { AppointmentStatus } from '../constants/appConstants.js';
import {
  MAX_CARS_PER_VISIT, NOTES_MAX_LENGTH, REASON_MAX_LENGTH, OUTCOME_MAX_LENGTH, CancellationType, CancelReasonCode,
  STAFF_CUSTOMER_SEARCH_MIN_CHARS,
} from '../constants/appointmentRules.js';

const OPTIONS = { abortEarly: false, allowUnknown: false, stripUnknown: false, convert: true };
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** ISO-8601 date-time that MUST carry a time zone (`Z` or `±hh:mm`). */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const objectId = Joi.string().pattern(OBJECT_ID).lowercase();
const dateKey = Joi.string().pattern(DATE_KEY);
const optionalText = (max) => Joi.string().trim().max(max).allow('', null).optional();
const page = Joi.number().integer().min(1);

/** `scheduledAt` string → Date (invalid calendar values such as month 13 are rejected). */
const toDate = (value, helpers) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? helpers.error('any.invalid') : date;
};

/** `a,b,c` → array of 1..MAX distinct lower-case ids. */
const parseCarIdList = (value, helpers) => {
  const ids = [...new Set(value.split(',').map((part) => part.trim().toLowerCase()))];
  if (!ids.every((id) => OBJECT_ID.test(id))) return helpers.error('any.invalid');
  return ids.length > MAX_CARS_PER_VISIT ? helpers.error('array.max') : ids;
};

export const createSchema = Joi.object({
  carIds: Joi.array().items(objectId).min(1).max(MAX_CARS_PER_VISIT).unique().required(),
  scheduledAt: Joi.string().pattern(ISO_WITH_OFFSET).custom(toDate).required(),
  notes: optionalText(NOTES_MAX_LENGTH),
});

export const slotsQuery = Joi.object({
  carIds: Joi.string().max(200).custom(parseCarIdList).required(),
  from: dateKey.required(),
  to: dateKey.required(),
  excludeVisitId: objectId, // 1.1.0: look at the slots as if this (own) visit had moved
});

/** 1.1.0: move a visit to another slot. */
export const rescheduleSchema = Joi.object({
  scheduledAt: Joi.string().pattern(ISO_WITH_OFFSET).custom(toDate).required(),
});

/** 1.1.0: staff slot grid; `carIds` optional (no cars → only capacity is judged). */
export const staffSlotsQuery = Joi.object({
  from: dateKey.required(),
  to: dateKey.required(),
  carIds: Joi.string().max(200).custom(parseCarIdList),
  excludeVisitId: objectId,
});

/** 1.1.0: staff look a customer up before booking for them. */
export const customerSearchQuery = Joi.object({
  q: Joi.string().trim().min(STAFF_CUSTOMER_SEARCH_MIN_CHARS).max(60).required(),
});

/** 1.1.0: staff book on behalf of a customer. */
export const staffCreateSchema = Joi.object({
  customerId: objectId.required(),
  carIds: Joi.array().items(objectId).min(1).max(MAX_CARS_PER_VISIT).unique().required(),
  scheduledAt: Joi.string().pattern(ISO_WITH_OFFSET).custom(toDate).required(),
  notes: optionalText(NOTES_MAX_LENGTH),
});

const statuses = Object.values(AppointmentStatus);

export const customerListQuery = Joi.object({
  status: Joi.string().valid(...statuses),
  page,
  limit: page,
});

export const cancelSchema = Joi.object({ reason: optionalText(REASON_MAX_LENGTH) });

export const staffListQuery = Joi.object({
  status: Joi.string().valid(...statuses),
  carId: objectId,
  from: dateKey,
  to: dateKey,
  cancellationType: Joi.string().valid(...Object.values(CancellationType)),
  needsReminderCall: Joi.boolean(),
  needsOutcome: Joi.boolean(),
  sort: Joi.string().valid('asc', 'desc'),
  page,
  limit: page,
});

export const statusSchema = Joi.object({
  status: Joi.string().valid(
    AppointmentStatus.CONFIRMED, AppointmentStatus.CANCELLED, AppointmentStatus.COMPLETED, AppointmentStatus.NO_SHOW,
  ).required(),
  reasonCode: Joi.string().valid(...Object.values(CancelReasonCode)).when('status', {
    is: AppointmentStatus.CANCELLED, then: Joi.optional(), otherwise: Joi.forbidden(),
  }),
  reason: optionalText(REASON_MAX_LENGTH),
  outcome: optionalText(OUTCOME_MAX_LENGTH),
});

const formatErrors = (error) => error.details.map((detail) => ({
  field: detail.path.join('.') || 'unknown',
  message: detail.message.replace(/['"]/g, ''),
}));

const strict = (schema, source) => (req, res, next) => {
  const { error, value } = schema.validate(req[source] ?? {}, OPTIONS);
  if (error) return sendError(res, MSG.MSG42.httpStatus, MSG.MSG42.message, MSG.MSG42.code, formatErrors(error));
  req[source] = value;
  return next();
};

/** Rejects unknown body fields with 422 VALIDATION_ERROR. */
export const validateBodyStrict = (schema) => strict(schema, 'body');
/** Rejects unknown query parameters with 422 VALIDATION_ERROR. */
export const validateQueryStrict = (schema) => strict(schema, 'query');
