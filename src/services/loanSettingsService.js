/**
 * @file loanSettingsService.js
 * @description Loan calculator configuration stored in the SystemSetting singleton
 * (`settingKey: 'LOAN_CONFIG'`, `groupName: 'finance'`). KAN-63.
 *
 * The first read is safe on a fresh database: defaults are returned without a
 * startup migration, and the first admin save creates the record (upsert).
 * Responses also carry `updatedAt` (ISO string, or null before the first save)
 * so the public calculator can show when the rates were last updated.
 */

import {
  LOAN_SETTINGS_KEY,
  LOAN_SETTINGS_GROUP,
  getDefaultLoanSettings,
  partnerRates,
  sortedUnique,
  termsInRange,
  toPublicLoanSettings,
} from '../config/loanSettings.js';
import SystemSetting from '../models/system-setting.model.js';

const mergeSettings = (storedValue) => {
  const defaults = getDefaultLoanSettings();
  if (!storedValue || typeof storedValue !== 'object') return toPublicLoanSettings(defaults);
  // Stored values win field by field, so a partial record keeps the defaults.
  const merged = { ...defaults, ...storedValue };
  if (!Array.isArray(merged.banks) || merged.banks.length === 0) merged.banks = defaults.banks;
  // Records saved before the option lists existed: derive them from the stored rules.
  if (!nonEmpty(storedValue.termOptions)) merged.termOptions = termsInRange(merged.minTermMonths, merged.maxTermMonths);
  if (!nonEmpty(storedValue.downPaymentOptions)) merged.downPaymentOptions = downOptionsFor(defaults.downPaymentOptions, merged.minDownPaymentPct);
  return toPublicLoanSettings(merged);
};

const nonEmpty = (list) => Array.isArray(list) && list.length > 0;

/** Down-payment buttons at or above the minimum; none left → just the minimum. */
const downOptionsFor = (options, minDownPaymentPct) => {
  const kept = sortedUnique(options.filter((pct) => pct >= minDownPaymentPct));
  return kept.length > 0 ? kept : [minDownPaymentPct];
};

const withUpdatedAt = (settings, record) => ({
  ...settings,
  updatedAt: record?.updatedAt ? new Date(record.updatedAt).toISOString() : null,
});

const findActiveRecord = () =>
  SystemSetting.findOne({ settingKey: LOAN_SETTINGS_KEY, status: 'ACTIVE' }).lean();

/**
 * Public read. Returns the defaults when nothing has been saved yet.
 * @returns {Promise<object>}
 */
export const getLoanSettings = async () => {
  const record = await findActiveRecord();
  return withUpdatedAt(mergeSettings(record?.value), record);
};

/**
 * Builds the value to store on top of the current settings (fields not sent are kept):
 *  - a sent bank list sets the chatbot promo rate from the partner bank;
 *  - sent `termOptions` set the chatbot min/max term; old clients sending only
 *    min/max get term options derived from that range;
 *  - down-payment options below the minimum down payment are dropped.
 */
const buildStoredValue = async (value) => {
  const current = await getLoanSettings();
  delete current.updatedAt;
  const next = { ...current, ...value };
  if (Array.isArray(value.banks)) Object.assign(next, partnerRates(value.banks));

  if (Array.isArray(value.termOptions)) {
    next.termOptions = sortedUnique(value.termOptions);
    next.minTermMonths = next.termOptions[0];
    next.maxTermMonths = next.termOptions[next.termOptions.length - 1];
  } else if (value.minTermMonths !== undefined || value.maxTermMonths !== undefined) {
    next.termOptions = termsInRange(next.minTermMonths, next.maxTermMonths);
  }
  next.downPaymentOptions = downOptionsFor(next.downPaymentOptions, next.minDownPaymentPct);
  return toPublicLoanSettings(next);
};

/**
 * Admin write. `findOneAndUpdate` with the unique settingKey converges concurrent
 * saves onto one document.
 *
 * @param {object} value - Already validated by the route schema.
 * @param {string} updatedByUserId
 * @returns {Promise<object>}
 */
export const updateLoanSettings = async (value, updatedByUserId) => {
  const normalized = await buildStoredValue(value);

  const record = await SystemSetting.findOneAndUpdate(
    { settingKey: LOAN_SETTINGS_KEY },
    {
      $set: {
        value: normalized,
        groupName: LOAN_SETTINGS_GROUP,
        description: 'Cấu hình tính trả góp: lãi suất các ngân hàng, trả trước tối thiểu, thời hạn vay.',
        status: 'ACTIVE',
        updatedByUserId,
      },
      $setOnInsert: { settingKey: LOAN_SETTINGS_KEY },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  return withUpdatedAt(mergeSettings(record?.value || normalized), record);
};

export default { getLoanSettings, updateLoanSettings };
