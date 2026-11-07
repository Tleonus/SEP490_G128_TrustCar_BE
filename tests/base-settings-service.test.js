/**
 * @file base-settings-service.test.js
 * @description Saving test-drive hours: partial input keeps current values and
 * the merged hours are range-checked. SystemSetting persistence is replaced, so
 * no database is touched.
 */

import { jest } from '@jest/globals';
import SystemSetting from '../src/models/system-setting.model.js';
import { getDefaultBaseSettings } from '../src/config/baseSettings.js';
import { updateBaseSettings } from '../src/services/baseSettingsService.js';

const lean = (value) => ({ lean: async () => value });

let stored;

beforeEach(() => {
  stored = null;
  jest.spyOn(SystemSetting, 'findOne').mockImplementation(() => lean(stored && { value: stored }));
  jest.spyOn(SystemSetting, 'findOneAndUpdate').mockImplementation((_filter, update) => {
    stored = update.$set.value;
    return lean({ value: stored });
  });
});

afterEach(() => jest.restoreAllMocks());

const payload = (testDrive) => ({ ...getDefaultBaseSettings(), testDrive });

describe('updateBaseSettings test-drive hours', () => {
  test('keeps the current hours when the form omits them', async () => {
    stored = { testDrive: { slotDurationMinutes: 60, maxGuestsPerSlot: 3, openTime: '08:00', closeTime: '18:00', lunchBreakStart: '11:30', lunchBreakEnd: '12:30' } };

    const saved = await updateBaseSettings(payload({ slotDurationMinutes: 45, maxGuestsPerSlot: 2 }), 'admin-id');

    expect(saved.testDrive).toEqual({ slotDurationMinutes: 45, maxGuestsPerSlot: 2, openTime: '08:00', closeTime: '18:00', lunchBreakStart: '11:30', lunchBreakEnd: '12:30' });
  });

  test('a record saved before the hours existed gets the default hours', async () => {
    stored = { testDrive: { slotDurationMinutes: 90, maxGuestsPerSlot: 2 } };

    const saved = await updateBaseSettings(payload({ slotDurationMinutes: 90, maxGuestsPerSlot: 2 }), 'admin-id');

    expect(saved.testDrive.openTime).toBe('09:00');
    expect(saved.testDrive.slotDurationMinutes).toBe(90);
  });

  test.each([
    ['open not before close', { openTime: '17:00', closeTime: '09:00' }],
    ['one field clashing with the current value', { openTime: '18:00' }],
    ['lunch start not before lunch end', { lunchBreakStart: '13:00', lunchBreakEnd: '12:00' }],
    ['lunch outside the hours', { lunchBreakStart: '07:00', lunchBreakEnd: '08:00' }],
  ])('rejects %s with 422 and saves nothing', async (_name, hours) => {
    await expect(updateBaseSettings(payload({ slotDurationMinutes: 60, maxGuestsPerSlot: 3, ...hours }), 'admin-id'))
      .rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
    expect(SystemSetting.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
