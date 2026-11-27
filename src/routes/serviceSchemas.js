/**
 * @file serviceSchemas.js
 * @description Joi DTO schemas for KAN-96 showroom service CRUD routes.
 *
 * The CREATE route owns `code` — it must be supplied and unique.
 * The UPDATE route omits `code` on purpose: once a service exists, its code
 * is the stable key used by appointment snapshots and must not drift.
 */

import Joi from 'joi';
import { RecordStatus } from '../models/extendedEnums.js';

const name  = Joi.string().trim().min(3).max(120);
const price = Joi.number().integer().min(0).max(500_000_000);
const duration = Joi.number().integer().min(15).max(480);
const code  = Joi.string().trim().uppercase().pattern(/^[A-Z0-9_]{3,40}$/);

export const createServiceSchema = Joi.object({
  code:              code.required(),
  serviceName:       name.required(),
  description:       Joi.string().trim().max(2000).allow('', null),
  estimatedDuration: duration.required(),
  referencePrice:    price.required(),
  status:            Joi.string().valid(...Object.values(RecordStatus)).default(RecordStatus.ACTIVE),
});

export const updateServiceSchema = Joi.object({
  serviceName:       name,
  description:       Joi.string().trim().max(2000).allow('', null),
  estimatedDuration: duration,
  referencePrice:    price,
  status:            Joi.string().valid(...Object.values(RecordStatus)),
}).min(1);

export const listServicesQuery = Joi.object({
  status: Joi.string().valid(...Object.values(RecordStatus)),
  search: Joi.string().trim().max(120).allow(''),
  page:   Joi.number().integer().min(1).default(1),
  limit:  Joi.number().integer().min(1).max(50).default(20),
});

export default { createServiceSchema, updateServiceSchema, listServicesQuery };
