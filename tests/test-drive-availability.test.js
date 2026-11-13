/**
 * @file test-drive-availability.test.js
 * @description Slot availability of a car, with time pinned to Monday 2026-11-09
 * 07:30 in Vietnam (00:30 UTC). Real services on the in-memory harness.
 */

import { setupTestDriveHarness } from './helpers/fakeTestDriveModels.js';

const h = await setupTestDriveHarness();
const { jest } = await import('@jest/globals');
const { findNearestSlots, getCarSlots } = await import('../src/services/testDriveAvailabilityService.js');
const { getDefaultBaseSettings } = await import('../src/config/baseSettings.js');

const NOW = new Date('2026-11-09T00:30:00.000Z');
const DATE = '2026-11-10'; // Tuesday
const at = (hhmm, date = DATE) => new Date(`${date}T${hhmm}:00+07:00`);
const slotAt = (slots, hhmm) => slots.find((slot) => slot.startAt.slice(11, 16) === hhmm);

let carId;
let staff;

beforeEach(async () => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'hrtime', 'performance'],
  });
  h.reset();
  carId = h.createCar();
  staff = [];
  for (let i = 0; i < 4; i += 1) staff.push((await h.createUser({ roleName: 'SALES_STAFF' })).id);
});

afterEach(() => jest.useRealTimers());

const hold = (overrides) => h.insertAppointment({
  customer: h.createCar(), car: h.createCar(), assignedTo: staff[0], scheduledAt: at('09:00'), slotSeat: 1, ...overrides,
});

describe('getCarSlots', () => {
  test('returns the 7 default slots as free, with offsets and no booking details', async () => {
    const slots = await getCarSlots(carId, DATE);
    expect(slots).toHaveLength(7);
    expect(slots[0]).toEqual({ startAt: '2026-11-10T09:00:00+07:00', endAt: '2026-11-10T10:00:00+07:00', available: true });
  });

  test('a closed day has no slots', async () => {
    expect(await getCarSlots(carId, '2026-11-15')).toEqual([]); // Sunday
  });

  test('applies the 2-hour notice using Vietnam time on a UTC clock', async () => {
    const slots = await getCarSlots(carId, '2026-11-09');
    expect(slotAt(slots, '09:00').available).toBe(false);
    expect(slotAt(slots, '10:00').available).toBe(true);
  });

  test('a slot more than 60 days ahead is not available', async () => {
    const slots = await getCarSlots(carId, '2027-01-11');
    expect(slots.every((slot) => slot.available === false)).toBe(true);
  });

  test('a slot where the car already has an appointment is not available', async () => {
    hold({ car: carId });
    const slots = await getCarSlots(carId, DATE);
    expect(slotAt(slots, '09:00').available).toBe(false);
    expect(slotAt(slots, '10:00').available).toBe(true);
  });

  test('a cancelled appointment does not block the slot', async () => {
    hold({ car: carId, status: 'CANCELLED', slotSeat: undefined });
    expect(slotAt(await getCarSlots(carId, DATE), '09:00').available).toBe(true);
  });

  test('a slot at capacity is not available for other cars', async () => {
    [0, 1, 2].forEach((i) => hold({ assignedTo: staff[i], slotSeat: i + 1 }));
    expect(slotAt(await getCarSlots(carId, DATE), '09:00').available).toBe(false);
  });

  test('no free staff makes a slot unavailable below capacity', async () => {
    h.useSettings({ testDrive: { ...getDefaultBaseSettings().testDrive, maxGuestsPerSlot: 10 } });
    staff.forEach((staffId, i) => hold({ assignedTo: staffId, slotSeat: i + 1 }));
    expect(slotAt(await getCarSlots(carId, DATE), '09:00').available).toBe(false);
  });

  test('a longer older appointment blocks every slot it overlaps', async () => {
    hold({ car: carId, durationMinutes: 90 });
    const slots = await getCarSlots(carId, DATE);
    expect(slotAt(slots, '09:00').available).toBe(false);
    expect(slotAt(slots, '10:00').available).toBe(false);
    expect(slotAt(slots, '11:00').available).toBe(true);
  });

  test.each([
    ['SOLD', { status: 'SOLD' }],
    ['inactive', { isActive: false }],
  ])('a %s car cannot be viewed for booking', async (_name, overrides) => {
    await expect(getCarSlots(h.createCar(overrides), DATE)).rejects.toMatchObject({ statusCode: 404, code: 'CAR_NOT_BOOKABLE' });
  });

  test('query count does not depend on the number of slots', async () => {
    h.Appointment.find.mockClear();
    await getCarSlots(carId, DATE);
    expect(h.Appointment.find).toHaveBeenCalledTimes(1);
    expect(h.User.find).toHaveBeenCalled();
  });
});

describe('findNearestSlots', () => {
  test('returns the 3 closest free slots of the car', async () => {
    hold({ car: carId, scheduledAt: at('10:00', '2026-11-09') });
    const slots = await findNearestSlots(carId);
    expect(slots.map((slot) => slot.startAt)).toEqual([
      '2026-11-09T11:00:00+07:00', '2026-11-09T13:00:00+07:00', '2026-11-09T14:00:00+07:00',
    ]);
  });
});
