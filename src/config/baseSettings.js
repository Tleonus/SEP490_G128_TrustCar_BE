/**
 * Canonical showroom configuration used by the public website and scheduling engine.
 * Keep editable business data here instead of duplicating values in frontend code.
 */

export const BASE_SETTINGS_KEY = 'showroom.base_settings';
export const BASE_SETTINGS_GROUP = 'SHOWROOM';
export const SETTINGS_TIMEZONE = 'Asia/Ho_Chi_Minh';

export const DAY_LABELS = Object.freeze([
  'Chủ nhật',
  'Thứ 2',
  'Thứ 3',
  'Thứ 4',
  'Thứ 5',
  'Thứ 6',
  'Thứ 7',
]);

const defaultWeeklySchedule = DAY_LABELS.map((label, dayOfWeek) => ({
  dayOfWeek,
  label,
  isOpen: dayOfWeek !== 0,
  openTime: dayOfWeek !== 0 ? '08:00' : null,
  closeTime: dayOfWeek !== 0 ? '20:00' : null,
}));

export const DEFAULT_BASE_SETTINGS = Object.freeze({
  contact: {
    showroomName: 'Showroom TrustCar',
    address: 'Quận 1, TP. Hồ Chí Minh',
    phone: '0856098686',
    email: 'support@trustcar.vn',
    mapUrl: 'https://www.google.com/maps/search/?api=1&query=Showroom+TrustCar%2C+Qu%E1%BA%ADn+1%2C+TP.+H%E1%BB%93+Ch%C3%AD+Minh',
    zaloUrl: 'https://zalo.me/0856098686',
    facebookUrl: 'https://www.facebook.com/tronghieu.7297',
    messengerUrl: 'https://m.me/tronghieu.7297',
    tiktokUrl: 'https://www.tiktok.com/@hieu_xeluot?is_from_webapp=1&sender_device=pc',
    tiktokHandle: '@hieu_xeluot',
  },
  businessHours: {
    timezone: SETTINGS_TIMEZONE,
    weeklySchedule: defaultWeeklySchedule,
    holidays: [],
  },
  testDrive: {
    slotDurationMinutes: 90,
    maxGuestsPerSlot: 2,
  },
});

const clone = (value) => JSON.parse(JSON.stringify(value));

const formatTimeRange = (day) => {
  if (!day.isOpen) return 'Đóng cửa';
  return `${day.openTime} - ${day.closeTime}`;
};

/**
 * Adds compatibility/display values consumed by the current homepage constants.
 * Canonical editable values remain contact/businessHours/testDrive.
 */
export const toPublicBaseSettings = (settings) => {
  const value = clone(settings);
  const contact = value.contact;
  const weeklySchedule = value.businessHours.weeklySchedule;

  const openDays = weeklySchedule.filter((day) => day.isOpen);
  const allOpenDaysShareHours = openDays.length > 0
    && openDays.every((day) => day.openTime === openDays[0].openTime && day.closeTime === openDays[0].closeTime);

  const showroomHours = allOpenDaysShareHours
    ? `${openDays[0].openTime} - ${openDays[0].closeTime} ${openDays.length === 7 ? 'hàng ngày' : 'vào ngày mở cửa'}`
    : weeklySchedule.map((day) => `${day.label}: ${formatTimeRange(day)}`).join(' · ');

  return {
    ...value,
    contact: {
      ...contact,
      phoneDisplay: contact.phone.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3'),
      phoneHref: `tel:${contact.phone}`,
      showroomDisplay: `${contact.showroomName}, ${contact.address}`,
      showroomHours,
    },
  };
};

export const getDefaultBaseSettings = () => toPublicBaseSettings(DEFAULT_BASE_SETTINGS);

export default {
  BASE_SETTINGS_KEY,
  BASE_SETTINGS_GROUP,
  SETTINGS_TIMEZONE,
  DAY_LABELS,
  DEFAULT_BASE_SETTINGS,
  getDefaultBaseSettings,
  toPublicBaseSettings,
};
