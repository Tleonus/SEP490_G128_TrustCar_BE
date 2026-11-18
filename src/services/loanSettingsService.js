/**
 * @file loanSettingsService.js
 * @description Loan calculator configuration stored in the SystemSetting singleton
 * (`settingKey: 'LOAN_CONFIG'`, `groupName: 'finance'`). KAN-63.
 *
 * The first read is safe on a fresh database: defaults are returned without a
 * startup migration, and the first admin save creates the record (upsert).
 */

import {
  LOAN_SETTINGS_KEY,
  LOAN_SETTINGS_GROUP,
  getDefaultLoanSettings,
  toPublicLoanSettings,
} from '../config/loanSettings.js';
import SystemSetting from '../models/system-setting.model.js';

const mergeSettings = (storedValue) => {
  const defaults = getDefaultLoanSettings();
  if (!storedValue || typeof storedValue !== 'object') return defaults;
  // Stored values win field by field, so a partial record keeps the defaults.
  return toPublicLoanSettings({ ...defaults, ...storedValue });
};

/**
 * Public read. Returns the placeholder defaults when nothing has been saved yet.
 * @returns {Promise<object>}
 */
export const getLoanSettings = async () => {
  const record = await SystemSetting.findOne({ settingKey: LOAN_SETTINGS_KEY, status: 'ACTIVE' }).lean();
  return mergeSettings(record?.value);
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
  const normalized = toPublicLoanSettings(value);

  const record = await SystemSetting.findOneAndUpdate(
    { settingKey: LOAN_SETTINGS_KEY },
    {
      $set: {
        value: normalized,
        groupName: LOAN_SETTINGS_GROUP,
        // The rates are placeholders until a partner bank confirms them.
        description: 'Cấu hình máy tính trả góp (lãi suất là placeholder, chờ ngân hàng đối tác xác nhận).',
        status: 'ACTIVE',
        updatedByUserId,
      },
      $setOnInsert: { settingKey: LOAN_SETTINGS_KEY },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  return mergeSettings(record?.value || normalized);
};

export default { getLoanSettings, updateLoanSettings };
