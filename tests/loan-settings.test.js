/**
 * @file loan-settings.test.js
 * @description KAN-63: loan calculator configuration. SystemSetting persistence is
 * replaced, so no database is touched.
 *
 * Covers: placeholder defaults on a fresh database, stored values winning over
 * defaults, partial records falling back field by field, and the admin upsert
 * converging on the single LOAN_CONFIG document.
 */

import { jest } from '@jest/globals';
import SystemSetting from '../src/models/system-setting.model.js';
import { LOAN_SETTINGS_KEY, LOAN_SETTINGS_GROUP, getDefaultLoanSettings } from '../src/config/loanSettings.js';
import { getLoanSettings, updateLoanSettings } from '../src/services/loanSettingsService.js';

const lean = (value) => ({ lean: async () => value });

let stored;

beforeEach(() => {
  stored = null;
  jest.spyOn(SystemSetting, 'findOne').mockImplementation(() => lean(stored && { value: stored, status: 'ACTIVE' }));
  jest.spyOn(SystemSetting, 'findOneAndUpdate').mockImplementation((filter, update) => {
    stored = update.$set.value;
    return lean({ value: stored, settingKey: filter.settingKey, groupName: update.$set.groupName });
  });
});

afterEach(() => jest.restoreAllMocks());

describe('getLoanSettings', () => {
  test('a fresh database returns the placeholder defaults without a migration', async () => {
    const settings = await getLoanSettings();

    expect(settings).toEqual(getDefaultLoanSettings());
    expect(SystemSetting.findOne).toHaveBeenCalledWith({ settingKey: LOAN_SETTINGS_KEY, status: 'ACTIVE' });
  });

  test('stored values win over the defaults', async () => {
    stored = { preferredRateAnnual: 6.9, floatingRateAnnual: 9.2, minDownPaymentPct: 30, minTermMonths: 6, maxTermMonths: 60 };

    expect(await getLoanSettings()).toEqual(stored);
  });

  test('a partial record keeps the defaults for the missing fields', async () => {
    stored = { preferredRateAnnual: 7 };

    const settings = await getLoanSettings();

    expect(settings.preferredRateAnnual).toBe(7);
    expect(settings.maxTermMonths).toBe(getDefaultLoanSettings().maxTermMonths);
  });

  test('only the five contract fields are returned', async () => {
    stored = { preferredRateAnnual: 7, internalNote: 'secret' };

    expect(Object.keys(await getLoanSettings()).sort()).toEqual(
      ['floatingRateAnnual', 'maxTermMonths', 'minDownPaymentPct', 'minTermMonths', 'preferredRateAnnual']
    );
  });
});

describe('updateLoanSettings', () => {
  test('upserts the singleton LOAN_CONFIG document in the finance group', async () => {
    const saved = await updateLoanSettings(
      { preferredRateAnnual: 7.5, floatingRateAnnual: 9.9, minDownPaymentPct: 15, minTermMonths: 12, maxTermMonths: 72 },
      'admin-id'
    );

    expect(saved.preferredRateAnnual).toBe(7.5);
    expect(saved.maxTermMonths).toBe(72);

    const [filter, update, options] = SystemSetting.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ settingKey: LOAN_SETTINGS_KEY });
    expect(update.$set.groupName).toBe(LOAN_SETTINGS_GROUP);
    expect(update.$set.updatedByUserId).toBe('admin-id');
    expect(update.$set.status).toBe('ACTIVE');
    expect(update.$setOnInsert).toEqual({ settingKey: LOAN_SETTINGS_KEY });
    expect(options).toMatchObject({ upsert: true, new: true });
  });

  test('drops fields outside the contract before storing', async () => {
    await updateLoanSettings(
      { preferredRateAnnual: 7.5, floatingRateAnnual: 9.9, minDownPaymentPct: 15, minTermMonths: 12, maxTermMonths: 72, injected: 'nope' },
      'admin-id'
    );

    expect(stored.injected).toBeUndefined();
    expect(Object.keys(stored)).toHaveLength(5);
  });
});
