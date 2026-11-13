import { updateBaseSettingsSchema } from '../src/routes/baseSettingsSchemas.js';
import { getDefaultBaseSettings } from '../src/config/baseSettings.js';

describe('base settings validation', () => {
  test('accepts complete admin form payload', () => {
    const { error, value } = updateBaseSettingsSchema.validate(getDefaultBaseSettings(), { abortEarly: false });
    expect(error).toBeUndefined();
    expect(value.contact.phone).toBe('0856098686');
  });

  test('rejects an invalid time range and invalid test-drive capacity', () => {
    const payload = getDefaultBaseSettings();
    payload.businessHours.weeklySchedule[1].openTime = '17:00';
    payload.businessHours.weeklySchedule[1].closeTime = '09:00';
    payload.testDrive.maxGuestsPerSlot = 0;

    const { error } = updateBaseSettingsSchema.validate(payload, { abortEarly: false });
    expect(error).toBeDefined();
    expect(error.details.map((detail) => detail.message).join(' ')).toMatch(/closeTime|maxGuestsPerSlot/);
  });

  test('accepts a form that does not send the new test-drive hours', () => {
    const payload = getDefaultBaseSettings();
    payload.testDrive = { slotDurationMinutes: 90, maxGuestsPerSlot: 2 };
    expect(updateBaseSettingsSchema.validate(payload).error).toBeUndefined();
  });

  test('rejects only one lunch-break time and a badly formatted time', () => {
    const payload = getDefaultBaseSettings();
    delete payload.testDrive.lunchBreakEnd;
    expect(updateBaseSettingsSchema.validate(payload).error).toBeDefined();

    const badFormat = getDefaultBaseSettings();
    badFormat.testDrive.openTime = '9h';
    expect(updateBaseSettingsSchema.validate(badFormat).error).toBeDefined();
  });
});
