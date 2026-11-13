/**
 * @file testDriveSchemas.js
 * @description Request DTOs for the test-drive API. The validate middleware strips
 * unknown fields, so a customer cannot pass a staff member, status or seat.
 */

import Joi from 'joi';
import { AppointmentStatus, TestDriveCancelReason } from '../constants/appConstants.js';

const objectId = Joi.string().hex().length(24);

/** A real calendar date, so 2026-02-31 is refused rather than rolled over. */
const localDate = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).custom((value, helpers) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return helpers.message('{{#label}} must be a real date.');
  }
  return value;
});

/** The offset is required: without one the time would depend on the server's timezone. */
const instantWithOffset = Joi.string()
  .pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/)
  .custom((value, helpers) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? helpers.message('{{#label}} must be a valid date-time.') : parsed;
  })
  .messages({ 'string.pattern.base': '{{#label}} must be ISO 8601 with an offset.' });

const paging = {
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
};

export const carSlotsParamsSchema = Joi.object({ carId: objectId.required() });
export const carSlotsQuerySchema = Joi.object({ date: localDate.required() });

export const bookSchema = Joi.object({
  carId: objectId.required(),
  scheduledAt: instantWithOffset.required(),
  notes: Joi.string().trim().max(2000).allow('', null),
});

export const listMineQuerySchema = Joi.object(paging);

export const listQuerySchema = Joi.object({
  ...paging,
  status: Joi.string().valid(...Object.values(AppointmentStatus)),
  date: localDate,
  staffId: objectId,
  needsAttention: Joi.boolean(),
});

export const assignSchema = Joi.object({ staffId: objectId.required() });

export const staffCancelSchema = Joi.object({
  reasonCode: Joi.string().valid(...Object.values(TestDriveCancelReason)).required(),
  note: Joi.when('reasonCode', {
    is: TestDriveCancelReason.OTHER,
    then: Joi.string().trim().min(1).max(400).required(),
    otherwise: Joi.string().trim().max(400).allow('', null),
  }),
});

export const outcomeSchema = Joi.object({ outcome: Joi.string().trim().min(1).max(1000).required() });

export default {
  carSlotsParamsSchema, carSlotsQuerySchema, bookSchema, listMineQuerySchema, listQuerySchema, assignSchema, staffCancelSchema, outcomeSchema,
};
