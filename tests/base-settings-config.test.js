import { getDefaultBaseSettings, toPublicBaseSettings } from '../src/config/baseSettings.js';

describe('base settings configuration', () => {
  test('ships safe defaults for a fresh database', () => {
    const settings = getDefaultBaseSettings();

    expect(settings.contact.phoneHref).toBe('tel:0856098686');
    expect(settings.contact.showroomDisplay).toContain('Showroom TrustCar');
    expect(settings.businessHours.weeklySchedule).toHaveLength(7);
    expect(settings.businessHours.weeklySchedule[0].isOpen).toBe(false);
    expect(settings.testDrive).toEqual({ slotDurationMinutes: 90, maxGuestsPerSlot: 2 });
  });

  test('derives legacy homepage display values from editable fields', () => {
    const settings = toPublicBaseSettings({
      contact: { showroomName: 'TrustCar Q1', address: '123 Lê Lợi', phone: '0901234567' },
      businessHours: {
        weeklySchedule: [
          { dayOfWeek: 0, label: 'Chủ nhật', isOpen: false, openTime: null, closeTime: null },
          ...Array.from({ length: 6 }, (_, index) => ({
            dayOfWeek: index + 1,
            label: `Thứ ${index + 2}`,
            isOpen: true,
            openTime: '09:00',
            closeTime: '17:00',
          })),
        ],
      },
      testDrive: { slotDurationMinutes: 60, maxGuestsPerSlot: 1 },
    });

    expect(settings.contact.phoneDisplay).toBe('0901 234 567');
    expect(settings.contact.showroomHours).toBe('09:00 - 17:00 vào ngày mở cửa');
  });
});
