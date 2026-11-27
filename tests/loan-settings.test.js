/**
 * @file loan-settings.test.js
 * @description KAN-63: loan calculator configuration. SystemSetting persistence is
 * replaced, so no database is touched.
 *
 * Covers: defaults on a fresh database, stored values winning over defaults,
 * partial records falling back field by field, the admin upsert converging on the
 * single LOAN_CONFIG document, and the bank list (partner-derived chatbot rates,
 * banks kept when a save omits them).
 */

import { jest } from '@jest/globals';
import SystemSetting from '../src/models/system-setting.model.js';
import {
  LOAN_SETTINGS_KEY, LOAN_SETTINGS_GROUP, getDefaultLoanSettings, toPublicLoanSettings,
} from '../src/config/loanSettings.js';
import { getLoanSettings, updateLoanSettings } from '../src/services/loanSettingsService.js';

const lean = (value) => ({ lean: async () => value });
const UPDATED_AT = new Date('2026-11-27T03:00:00.000Z');

let stored;

beforeEach(() => {
  stored = null;
  jest.spyOn(SystemSetting, 'findOne').mockImplementation(() => lean(stored && { value: stored, status: 'ACTIVE', updatedAt: UPDATED_AT }));
  jest.spyOn(SystemSetting, 'findOneAndUpdate').mockImplementation((filter, update) => {
    stored = update.$set.value;
    return lean({ value: stored, settingKey: filter.settingKey, groupName: update.$set.groupName, updatedAt: UPDATED_AT });
  });
});

afterEach(() => jest.restoreAllMocks());

const scalars = { preferredRateAnnual: 7.5, floatingRateAnnual: 9.9, minDownPaymentPct: 15, minTermMonths: 12, maxTermMonths: 72 };

const bank = (overrides = {}) => ({
  id: 'ACB', name: 'ACB', isPartner: false, active: true, promoRate: 9,
  maxLoanPct: null, minLoanAmount: null, minTermMonths: null, maxTermMonths: null,
  note: '', cars: '', sourceUrl: '', sourceDate: '', ...overrides,
});

describe('getLoanSettings', () => {
  test('a fresh database returns the defaults (with 4 banks, TPBank partner) and no updatedAt', async () => {
    const settings = await getLoanSettings();

    expect(settings).toEqual({ ...toPublicLoanSettings(getDefaultLoanSettings()), updatedAt: null });
    expect(settings.banks.map((item) => item.id)).toEqual(['TPBANK', 'MSB', 'PVCOMBANK', 'HLBANK']);
    expect(settings.banks.filter((item) => item.isPartner).map((item) => item.id)).toEqual(['TPBANK']);
    expect(settings.minDownPaymentPct).toBe(30);
    expect(SystemSetting.findOne).toHaveBeenCalledWith({ settingKey: LOAN_SETTINGS_KEY, status: 'ACTIVE' });
  });

  test('stored values win over the defaults; updatedAt is the record time', async () => {
    stored = { ...scalars, banks: [bank({ isPartner: true })] };

    const settings = await getLoanSettings();

    expect(settings.preferredRateAnnual).toBe(7.5);
    expect(settings.banks).toEqual([bank({ isPartner: true })]);
    expect(settings.updatedAt).toBe(UPDATED_AT.toISOString());
  });

  test('a record saved before the bank list existed still gets the default banks', async () => {
    stored = { preferredRateAnnual: 7 };

    const settings = await getLoanSettings();

    expect(settings.preferredRateAnnual).toBe(7);
    expect(settings.maxTermMonths).toBe(getDefaultLoanSettings().maxTermMonths);
    expect(settings.banks).toHaveLength(4);
  });

  test('only the contract fields are returned (bank fields too)', async () => {
    stored = { preferredRateAnnual: 7, internalNote: 'secret', banks: [bank({ isPartner: true, secret: 'x' })] };

    const settings = await getLoanSettings();

    expect(Object.keys(settings).sort()).toEqual(
      ['banks', 'downPaymentOptions', 'floatingRateAnnual', 'maxTermMonths', 'minDownPaymentPct', 'minTermMonths', 'preferredRateAnnual', 'termOptions', 'updatedAt']
    );
    expect(settings.banks[0].secret).toBeUndefined();
  });
});

describe('updateLoanSettings', () => {
  test('upserts the singleton LOAN_CONFIG document in the finance group', async () => {
    const saved = await updateLoanSettings(scalars, 'admin-id');

    expect(saved.preferredRateAnnual).toBe(7.5);
    expect(saved.maxTermMonths).toBe(72);
    expect(saved.updatedAt).toBe(UPDATED_AT.toISOString());

    const [filter, update, options] = SystemSetting.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ settingKey: LOAN_SETTINGS_KEY });
    expect(update.$set.groupName).toBe(LOAN_SETTINGS_GROUP);
    expect(update.$set.updatedByUserId).toBe('admin-id');
    expect(update.$set.status).toBe('ACTIVE');
    expect(update.$setOnInsert).toEqual({ settingKey: LOAN_SETTINGS_KEY });
    expect(options).toMatchObject({ upsert: true, new: true });
  });

  test('drops fields outside the contract before storing', async () => {
    await updateLoanSettings({ ...scalars, injected: 'nope' }, 'admin-id');

    expect(stored.injected).toBeUndefined();
    expect(Object.keys(stored).sort()).toEqual(
      ['banks', 'downPaymentOptions', 'floatingRateAnnual', 'maxTermMonths', 'minDownPaymentPct', 'minTermMonths', 'preferredRateAnnual', 'termOptions']
    );
  });

  test('a save without banks keeps the current bank list', async () => {
    stored = { ...scalars, banks: [bank({ isPartner: true })] };

    await updateLoanSettings({ ...scalars, minDownPaymentPct: 25 }, 'admin-id');

    expect(stored.minDownPaymentPct).toBe(25);
    expect(stored.banks).toEqual([bank({ isPartner: true })]);
  });

  test('a save with banks takes the chatbot promo rate from the partner bank and keeps the chatbot floating rate', async () => {
    stored = { ...scalars, banks: [bank({ isPartner: true })] };
    const banks = [bank(), bank({ id: 'VCB', name: 'VCB', isPartner: true, promoRate: 7.2 })];

    const saved = await updateLoanSettings({ minDownPaymentPct: 30, minTermMonths: 12, maxTermMonths: 84, banks }, 'admin-id');

    expect(saved.preferredRateAnnual).toBe(7.2);
    expect(saved.floatingRateAnnual).toBe(9.9);
    expect(saved.banks.map((item) => item.id)).toEqual(['ACB', 'VCB']);
  });

  test('old post-promotion fields are not stored or returned', async () => {
    const banks = [{ ...bank({ isPartner: true }), promoMonths: 6, floatingRate: 13, baseRate: 10.9, margin: 0.99 }];

    const saved = await updateLoanSettings({ minDownPaymentPct: 30, minTermMonths: 12, maxTermMonths: 84, banks }, 'admin-id');

    expect(saved.banks[0]).not.toHaveProperty('floatingRate');
    expect(saved.banks[0]).not.toHaveProperty('promoMonths');
    expect(stored.banks[0]).not.toHaveProperty('baseRate');
    expect(stored.banks[0]).not.toHaveProperty('margin');
  });

  test('defaults: no post-promotion rate on any bank; MSB hidden (rate below the partner)', () => {
    const { banks, floatingRateAnnual } = getDefaultLoanSettings();
    banks.forEach((item) => expect(item).not.toHaveProperty('floatingRate'));
    expect(banks.find((item) => item.id === 'MSB').active).toBe(false);
    expect(floatingRateAnnual).toBe(10.5);
  });

  test('first save with banks on a fresh database keeps the default chatbot floating rate', async () => {
    const saved = await updateLoanSettings(
      { minDownPaymentPct: 30, minTermMonths: 12, maxTermMonths: 84, banks: [bank({ isPartner: true, promoRate: 8 })] },
      'admin-id'
    );

    expect(saved.preferredRateAnnual).toBe(8);
    expect(saved.floatingRateAnnual).toBe(10.5);
  });
});

describe('term and down-payment options', () => {
  test('a record saved before the option lists existed derives them from its rules', async () => {
    stored = { ...scalars, minDownPaymentPct: 35, minTermMonths: 24, maxTermMonths: 96, banks: [bank({ isPartner: true })] };

    const settings = await getLoanSettings();

    expect(settings.termOptions).toEqual([24, 36, 48, 60, 72, 84, 96]);
    expect(settings.downPaymentOptions).toEqual([40, 50, 70]);
  });

  test('sent term options are sorted and set the chatbot min/max term', async () => {
    const saved = await updateLoanSettings({ minDownPaymentPct: 30, termOptions: [36, 12, 18], downPaymentOptions: [50, 30] }, 'admin-id');

    expect(saved.termOptions).toEqual([12, 18, 36]);
    expect(saved.minTermMonths).toBe(12);
    expect(saved.maxTermMonths).toBe(36);
    expect(saved.downPaymentOptions).toEqual([30, 50]);
    expect(saved.banks).toHaveLength(4);
  });

  test('old clients sending only min/max get options from that range; options below a raised minimum are dropped', async () => {
    stored = { ...scalars, minDownPaymentPct: 30, termOptions: [12, 18], downPaymentOptions: [30, 40, 60], banks: [bank({ isPartner: true })] };

    const saved = await updateLoanSettings({ ...scalars, minDownPaymentPct: 40, minTermMonths: 24, maxTermMonths: 48 }, 'admin-id');

    expect(saved.termOptions).toEqual([24, 36, 48]);
    expect(saved.downPaymentOptions).toEqual([40, 60]);
  });
});
