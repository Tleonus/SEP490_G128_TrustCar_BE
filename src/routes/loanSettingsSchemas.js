/**
 * @file loanSettingsSchemas.js
 * @description Joi schema for PUT /api/v1/settings/loan (KAN-63 + bank list).
 * Bank rule messages are Vietnamese because the admin screen shows them as is.
 *
 * Option lists the customer picks from: `termOptions` (months, 1–120) and
 * `downPaymentOptions` (%, each ≥ minDownPaymentPct). When `termOptions` is sent,
 * min/max term are optional (derived by the service).
 *
 * Per bank: promotional rate and optional loan
 * conditions (max % of car price, min amount, term range). Unknown keys (such as
 * the removed promoMonths / floatingRate / baseRate / margin) are stripped by the middleware.
 */

import Joi from 'joi';
import { MAX_BANKS } from '../config/loanSettings.js';

const RATE_MAX = 100;
const BANK_RATE_MAX = 40;
const DOWN_PCT_MAX = 90;
const TERM_MAX = 360;
const LOAN_AMOUNT_MAX = 100_000_000_000;
const TERM_OPTION_MAX = 120;
const MAX_TERM_OPTIONS = 12;
const MAX_DOWN_OPTIONS = 8;

const range = (label, min, max, unit = '') => {
  const text = `${label} phải từ ${min} đến ${max}${unit}.`;
  return { 'number.min': text, 'number.max': text, 'number.base': `${label} phải là số.`, 'number.integer': `${label} phải là số nguyên.` };
};

const optionalNumber = (label, min, max, unit, integer = false) => {
  const base = integer ? Joi.number().integer() : Joi.number();
  return base.min(min).max(max).allow(null).default(null).messages(range(label, min, max, unit));
};

/** Cross-field rules of one bank; returns a Vietnamese message or null. */
const bankRuleError = (bank) => {
  if (bank.minTermMonths !== null && bank.maxTermMonths !== null && bank.minTermMonths > bank.maxTermMonths) {
    return `${bank.name}: thời hạn tối thiểu không được lớn hơn thời hạn tối đa.`;
  }
  return null;
};

const bankSchema = Joi.object({
  id: Joi.string().trim().uppercase().pattern(/^[A-Z0-9_-]{2,20}$/).required()
    .messages({ 'string.pattern.base': 'Mã ngân hàng chỉ gồm chữ, số, "_" hoặc "-", dài 2–20 ký tự.' }),
  name: Joi.string().trim().min(1).max(60).required()
    .messages({ 'string.empty': 'Tên ngân hàng không được để trống.' }),
  isPartner: Joi.boolean().required(),
  active: Joi.boolean().required(),
  promoRate: Joi.number().min(0).max(BANK_RATE_MAX).required()
    .messages({ 'number.max': `Lãi suất phải từ 0 đến ${BANK_RATE_MAX} %/năm.`, 'number.min': `Lãi suất phải từ 0 đến ${BANK_RATE_MAX} %/năm.` }),
  maxLoanPct: optionalNumber('Tỷ lệ cho vay tối đa', 1, 100, '% giá xe', true),
  minLoanAmount: optionalNumber('Số tiền vay tối thiểu', 0, LOAN_AMOUNT_MAX, ' đ', true),
  minTermMonths: optionalNumber('Thời hạn tối thiểu', 1, TERM_MAX, ' tháng', true),
  maxTermMonths: optionalNumber('Thời hạn tối đa', 1, TERM_MAX, ' tháng', true),
  note: Joi.string().trim().max(160).allow('').default(''),
  cars: Joi.string().trim().max(60).allow('').default(''),
  sourceUrl: Joi.string().trim().max(500).uri({ scheme: ['https', 'http'] }).allow('').default('')
    .messages({
      'string.uri': 'Link nguồn phải là địa chỉ web (http/https).',
      'string.uriCustomScheme': 'Link nguồn phải là địa chỉ web (http/https).',
    }),
  sourceDate: Joi.string().trim().max(30).allow('').default(''),
}).custom((bank, helpers) => {
  const error = bankRuleError(bank);
  return error ? helpers.message({ custom: error }) : bank;
});

const banksSchema = Joi.array().items(bankSchema).min(1).max(MAX_BANKS)
  .unique('id')
  .custom((banks, helpers) => {
    const partners = banks.filter((bank) => bank.isPartner);
    if (partners.length !== 1) return helpers.message({ custom: 'Phải chọn đúng 1 ngân hàng liên kết.' });
    if (!partners[0].active) return helpers.message({ custom: 'Ngân hàng liên kết phải đang hiện trên trang tính.' });
    return banks;
  })
  .messages({
    'array.unique': 'Mã ngân hàng bị trùng.',
    'array.max': `Tối đa ${MAX_BANKS} ngân hàng.`,
    'array.min': 'Cần ít nhất 1 ngân hàng.',
  });

/** When `banks` is sent the scalar rates are optional (promo rate follows the partner bank). */
const scalarRate = (field) => Joi.number().min(0).max(RATE_MAX)
  .when('banks', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() })
  .messages({ 'any.required': `${field} is required.` });

/** When `termOptions` is sent, min/max term are derived from it by the service. */
const termBound = (field) => Joi.number().integer().min(1).max(TERM_MAX)
  .when('termOptions', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() })
  .messages({ 'any.required': `${field} is required.` });

const termOptionsSchema = Joi.array().items(
  Joi.number().integer().min(1).max(TERM_OPTION_MAX)
    .messages(range('Thời hạn vay', 1, TERM_OPTION_MAX, ' tháng'))
).min(1).max(MAX_TERM_OPTIONS).unique()
  .messages({
    'array.min': 'Cần ít nhất 1 thời hạn vay.',
    'array.max': `Tối đa ${MAX_TERM_OPTIONS} thời hạn vay.`,
    'array.unique': 'Thời hạn vay bị trùng.',
  });

const downOptionsSchema = Joi.array().items(
  Joi.number().integer().min(0).max(DOWN_PCT_MAX)
    .messages(range('Mức trả trước', 0, DOWN_PCT_MAX, '%'))
).min(1).max(MAX_DOWN_OPTIONS).unique()
  .messages({
    'array.min': 'Cần ít nhất 1 mức trả trước.',
    'array.max': `Tối đa ${MAX_DOWN_OPTIONS} mức trả trước.`,
    'array.unique': 'Mức trả trước bị trùng.',
  });

export const updateLoanSettingsSchema = Joi.object({
  preferredRateAnnual: scalarRate('preferredRateAnnual'),
  floatingRateAnnual: scalarRate('floatingRateAnnual'),
  minDownPaymentPct: Joi.number().min(0).max(DOWN_PCT_MAX).required()
    .messages({ 'any.required': 'minDownPaymentPct is required.', 'number.max': `Trả trước tối thiểu phải từ 0 đến ${DOWN_PCT_MAX}%.` }),
  minTermMonths: termBound('minTermMonths'),
  maxTermMonths: termBound('maxTermMonths')
    .when('minTermMonths', { is: Joi.exist(), then: Joi.number().greater(Joi.ref('minTermMonths')) })
    .messages({ 'number.greater': 'Thời hạn tối đa phải lớn hơn thời hạn tối thiểu.' }),
  termOptions: termOptionsSchema,
  downPaymentOptions: downOptionsSchema,
  banks: banksSchema,
}).custom((value, helpers) => {
  const low = (value.downPaymentOptions ?? []).filter((pct) => pct < value.minDownPaymentPct);
  if (low.length > 0) {
    return helpers.message({ custom: `Mức trả trước ${low.join('%, ')}% thấp hơn trả trước tối thiểu ${value.minDownPaymentPct}%.` });
  }
  return value;
});

export default updateLoanSettingsSchema;
