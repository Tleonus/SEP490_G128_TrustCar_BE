import { BASE_SETTINGS_GROUP, BASE_SETTINGS_KEY, getDefaultBaseSettings, toPublicBaseSettings } from '../config/baseSettings.js';
import SystemSetting from '../models/system-setting.model.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

const toStoredValue = (settings) => ({
  contact: {
    showroomName: settings.contact.showroomName,
    address: settings.contact.address,
    phone: settings.contact.phone,
    email: settings.contact.email,
    mapUrl: settings.contact.mapUrl || '',
    zaloUrl: settings.contact.zaloUrl || '',
    facebookUrl: settings.contact.facebookUrl || '',
    messengerUrl: settings.contact.messengerUrl || '',
    tiktokUrl: settings.contact.tiktokUrl || '',
    tiktokHandle: settings.contact.tiktokHandle || '',
  },
  businessHours: settings.businessHours,
  testDrive: settings.testDrive,
});

const mergeSettings = (storedValue) => {
  const defaults = getDefaultBaseSettings();
  if (!storedValue || typeof storedValue !== 'object') return defaults;

  return toPublicBaseSettings({
    ...defaults,
    ...storedValue,
    contact: { ...defaults.contact, ...(storedValue.contact || {}) },
    businessHours: {
      ...defaults.businessHours,
      ...(storedValue.businessHours || {}),
      weeklySchedule: storedValue.businessHours?.weeklySchedule || defaults.businessHours.weeklySchedule,
      holidays: storedValue.businessHours?.holidays || defaults.businessHours.holidays,
    },
    testDrive: { ...defaults.testDrive, ...(storedValue.testDrive || {}) },
  });
};

/**
 * Reads showroom settings. The first read is also safe on a fresh database:
 * defaults are returned without requiring a startup migration.
 */
export const getBaseSettings = async () => {
  const record = await SystemSetting.findOne({ settingKey: BASE_SETTINGS_KEY, status: 'ACTIVE' }).lean();
  return mergeSettings(record?.value);
};

/**
 * Updates the singleton settings record. `findOneAndUpdate` makes concurrent
 * admin saves converge on one setting document because settingKey is unique.
 */
export const updateBaseSettings = async (value, updatedByUserId) => {
  const normalized = toPublicBaseSettings(value);
  const editableValue = clone(toStoredValue(normalized));

  const record = await SystemSetting.findOneAndUpdate(
    { settingKey: BASE_SETTINGS_KEY },
    {
      $set: {
        value: editableValue,
        groupName: BASE_SETTINGS_GROUP,
        description: 'Thông tin liên hệ, giờ hoạt động và cấu hình lịch lái thử.',
        status: 'ACTIVE',
        updatedByUserId,
      },
      $setOnInsert: { settingKey: BASE_SETTINGS_KEY },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  return mergeSettings(record?.value || editableValue);
};

export default { getBaseSettings, updateBaseSettings };
