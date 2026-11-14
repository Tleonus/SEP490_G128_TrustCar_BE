import Joi from 'joi';
import { DAY_LABELS, SETTINGS_TIMEZONE } from '../config/baseSettings.js';
import { joiPhone } from '../utils/validators.js';

const timeSchema = Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).messages({
  'string.pattern.base': '{{#label}} must use HH:mm format.',
});

const optionalUrl = Joi.string().trim().uri({ scheme: ['http', 'https'] }).max(500).allow('', null);

const weeklyDaySchema = Joi.object({
  dayOfWeek: Joi.number().integer().min(0).max(6).required(),
  label: Joi.string().trim().valid(...DAY_LABELS).required(),
  isOpen: Joi.boolean().required(),
  openTime: Joi.when('isOpen', { is: true, then: timeSchema.required(), otherwise: Joi.valid(null, '').default(null) }),
  closeTime: Joi.when('isOpen', { is: true, then: timeSchema.required(), otherwise: Joi.valid(null, '').default(null) }),
}).custom((day, helpers) => {
  if (day.isOpen && day.openTime >= day.closeTime) {
    return helpers.message('closeTime must be later than openTime.');
  }
  return day;
});

const baseSettingsShape = {
  contact: Joi.object({
    showroomName: Joi.string().trim().min(2).max(150).required(),
    address: Joi.string().trim().min(2).max(300).required(),
    phone: joiPhone().required(),
    email: Joi.string().trim().email().max(150).required(),
    mapUrl: optionalUrl,
    zaloUrl: optionalUrl,
    facebookUrl: optionalUrl,
    messengerUrl: optionalUrl,
    tiktokUrl: optionalUrl,
    tiktokHandle: Joi.string().trim().max(80).allow('', null),
    // Derived homepage compatibility fields are accepted on read-then-save, but never persisted.
    phoneDisplay: Joi.string().strip(),
    phoneHref: Joi.string().strip(),
    showroomDisplay: Joi.string().strip(),
    showroomHours: Joi.string().strip(),
  }).required(),
  businessHours: Joi.object({
    timezone: Joi.string().trim().default(SETTINGS_TIMEZONE),
    weeklySchedule: Joi.array().items(weeklyDaySchema).length(7).unique('dayOfWeek').required(),
    holidays: Joi.array().items(Joi.string().isoDate()).max(100).default([]),
  }).required(),
  testDrive: Joi.object({
    slotDurationMinutes: Joi.number().integer().min(15).max(480).required(),
    maxGuestsPerSlot: Joi.number().integer().min(1).max(100).required(),
    // Optional so existing admin forms keep working; the service merges and range-checks them.
    openTime: timeSchema,
    closeTime: timeSchema,
    lunchBreakStart: timeSchema,
    lunchBreakEnd: timeSchema,
  }).and('lunchBreakStart', 'lunchBreakEnd').required(),
};

export const baseSettingsSchema = Joi.object(baseSettingsShape);
export const updateBaseSettingsSchema = baseSettingsSchema;

export default { baseSettingsSchema, updateBaseSettingsSchema };
