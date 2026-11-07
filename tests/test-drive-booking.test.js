/**
 * @file test-drive-booking.test.js
 * @description Booking a test drive, with time pinned to Monday 2026-11-09 07:30 in
 * Vietnam. Requests run one at a time on the harness, so lost races are simulated:
 * this exercises the retry path but does not prove real MongoDB concurrency.
 */

import { setupTestDriveHarness } from './helpers/fakeTestDriveModels.js';

const h = await setupTestDriveHarness();
const { jest } = await import('@jest/globals');
const { default: mongoose } = await import('mongoose');
const { bookOnline } = await import('../src/services/testDriveBookingService.js');
const { getDefaultBaseSettings } = await import('../src/config/baseSettings.js');

const NOW = new Date('2026-11-09T00:30:00.000Z');
const SLOT = new Date('2026-11-10T09:00:00+07:00');

let staff;

const newCustomer = async (index = 0) => {
  const customer = await h.createCustomer({ phone: `09012345${String(index).padStart(2, '0')}` });
  const account = await h.createUser({ roleName: 'CUSTOMER', customer, phone: `09012345${String(index).padStart(2, '0')}` });
  return { _id: new mongoose.Types.ObjectId(account.id), email: account.email, customer };
};

beforeEach(async () => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'hrtime', 'performance'],
  });
  h.reset();
  staff = [];
  for (let i = 0; i < 4; i += 1) staff.push((await h.createUser({ roleName: 'SALES_STAFF' })).id);
});

afterEach(() => jest.useRealTimers());

describe('bookOnline', () => {
  test('books a free slot: PENDING, coded, least-busy staff, seat taken, audited', async () => {
    const user = await newCustomer();
    const carId = h.createCar();
    h.insertAppointment({ customer: h.createCar(), car: h.createCar(), assignedTo: staff[0], scheduledAt: new Date('2026-11-10T13:00:00+07:00'), slotSeat: 1 });

    const booked = await bookOnline({ user, carId, scheduledAt: SLOT, notes: 'Muốn lái thử' });

    expect(booked).toMatchObject({
      appointmentCode: expect.stringMatching(/^APT-\d{4}$/), carId, scheduledAt: '2026-11-10T09:00:00+07:00', durationMinutes: 60, status: 'PENDING',
    });
    expect(booked.assignedTo).toBeUndefined();
    const stored = h.appointment(booked.id);
    expect(stored.type).toBe('TEST_DRIVE');
    expect(stored.slotSeat).toBe(1);
    expect(String(stored.assignedTo)).toBe(staff[1]);
    expect(h.activity).toEqual([expect.objectContaining({ eventType: 'APPOINTMENT_CREATED', targetModel: 'Appointment' })]);
  });

  test('a customer without a linked profile cannot book', async () => {
    await expect(bookOnline({ user: { _id: 'x', email: 'a@b.c' }, carId: h.createCar(), scheduledAt: SLOT }))
      .rejects.toMatchObject({ statusCode: 403, code: 'PROFILE_INCOMPLETE' });
  });

  test.each([
    ['SOLD car', { status: 'SOLD' }],
    ['inactive car', { isActive: false }],
  ])('a %s cannot be booked', async (_name, overrides) => {
    await expect(bookOnline({ user: await newCustomer(), carId: h.createCar(overrides), scheduledAt: SLOT }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CAR_NOT_BOOKABLE' });
  });

  test('a time that is not a slot start is refused', async () => {
    await expect(bookOnline({ user: await newCustomer(), carId: h.createCar(), scheduledAt: new Date('2026-11-10T09:30:00+07:00') }))
      .rejects.toMatchObject({ statusCode: 422, code: 'INVALID_SLOT' });
  });

  test('a slot under 2 hours away is refused', async () => {
    await expect(bookOnline({ user: await newCustomer(), carId: h.createCar(), scheduledAt: new Date('2026-11-09T09:00:00+07:00') }))
      .rejects.toMatchObject({ statusCode: 422, code: 'SCHEDULE_OUT_OF_WINDOW' });
  });

  test('a car already booked in the slot gets CAR_SLOT_TAKEN with alternatives', async () => {
    const carId = h.createCar();
    await bookOnline({ user: await newCustomer(1), carId, scheduledAt: SLOT });

    const error = await bookOnline({ user: await newCustomer(2), carId, scheduledAt: SLOT }).catch((e) => e);

    expect(error).toMatchObject({ statusCode: 409, code: 'CAR_SLOT_TAKEN' });
    expect(error.errors.nearestSlots).toHaveLength(3);
  });

  test('customer limits apply and create nothing', async () => {
    const user = await newCustomer();
    const carId = h.createCar();
    await bookOnline({ user, carId, scheduledAt: SLOT });
    await expect(bookOnline({ user, carId, scheduledAt: new Date('2026-11-11T09:00:00+07:00') }))
      .rejects.toMatchObject({ code: 'CAR_BOOKING_LIMIT' });
    expect(h.appointments.size).toBe(1);
    expect(h.activity).toHaveLength(1);
  });
});

describe('simultaneous bookings', () => {
  const summarise = (results) => ({
    won: results.filter((r) => r.status === 'fulfilled').length,
    codes: new Set(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code)),
  });

  const assertNoDuplicates = () => {
    const rows = [...h.appointments.values()];
    const unique = (key) => new Set(rows.map((a) => String(a[key]))).size;
    expect(unique('slotSeat')).toBe(rows.length);
    expect(unique('assignedTo')).toBe(rows.length);
    expect(unique('car')).toBe(rows.length);
    expect(unique('appointmentCode')).toBe(rows.length);
  };

  test('20 customers and 20 cars on one slot: exactly the capacity wins', async () => {
    const users = [];
    for (let i = 0; i < 20; i += 1) users.push(await newCustomer(i));

    const { won, codes } = summarise(await Promise.allSettled(
      users.map((user) => bookOnline({ user, carId: h.createCar(), scheduledAt: SLOT })),
    ));

    expect(won).toBe(3);
    expect([...codes]).toEqual(['SLOT_FULL']);
    assertNoDuplicates();
  });

  test('20 customers on one car: exactly one wins', async () => {
    const carId = h.createCar();
    const users = [];
    for (let i = 0; i < 20; i += 1) users.push(await newCustomer(i));

    const { won, codes } = summarise(await Promise.allSettled(
      users.map((user) => bookOnline({ user, carId, scheduledAt: SLOT })),
    ));

    expect(won).toBe(1);
    expect([...codes]).toEqual(['CAR_SLOT_TAKEN']);
  });

  test('one customer sending 20 requests for different cars stays within the limit', async () => {
    const user = await newCustomer();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => bookOnline({
        user, carId: h.createCar(), scheduledAt: new Date(`2026-11-${10 + (i % 5)}T09:00:00+07:00`),
      })),
    );
    expect(summarise(results).won).toBe(2);
  });

  test('losing the race for a car on the unique index retries and reports the winner', async () => {
    const carId = h.createCar();
    h.beforeNextCreate(() => h.insertAppointment({ customer: h.createCar(), car: carId, assignedTo: staff[3], scheduledAt: SLOT, slotSeat: 2 }));

    await expect(bookOnline({ user: await newCustomer(), carId, scheduledAt: SLOT }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CAR_SLOT_TAKEN' });
    expect(h.stats.aborted).toBe(1);
    expect(h.appointments.size).toBe(1);
  });

  test('losing the race for a seat retries and takes the next seat', async () => {
    h.beforeNextCreate(() => h.insertAppointment({ customer: h.createCar(), car: h.createCar(), assignedTo: staff[3], scheduledAt: SLOT, slotSeat: 1 }));

    const booked = await bookOnline({ user: await newCustomer(), carId: h.createCar(), scheduledAt: SLOT });

    expect(h.appointment(booked.id).slotSeat).toBe(2);
    expect(h.stats).toMatchObject({ aborted: 1, committed: 1 });
  });

  test('a write conflict retries and succeeds, leaving no partial data', async () => {
    h.failNextCreates(h.writeConflict(), h.writeConflict());

    await bookOnline({ user: await newCustomer(), carId: h.createCar(), scheduledAt: SLOT });

    expect(h.stats).toMatchObject({ aborted: 2, committed: 1 });
    expect(h.appointments.size).toBe(1);
    expect(h.activity).toHaveLength(1);
  });

  test('clashing appointment codes do not use up the attempts for the slot', async () => {
    const codeClash = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern: { appointmentCode: 1 } });
    h.failNextCreates(...Array.from({ length: 7 }, codeClash));

    await bookOnline({ user: await newCustomer(), carId: h.createCar(), scheduledAt: SLOT });

    expect(h.stats).toMatchObject({ aborted: 7, committed: 1 });
  });

  test('a showroom name and address longer than the location field do not block booking', async () => {
    const settings = getDefaultBaseSettings();
    settings.contact = { ...settings.contact, address: 'A'.repeat(300), showroomName: 'B'.repeat(150) };
    h.useSettings(settings);

    const booked = await bookOnline({ user: await newCustomer(), carId: h.createCar(), scheduledAt: SLOT });

    expect(booked.location).toHaveLength(300);
  });

  test('too many conflicts give SLOT_FULL with alternatives, and create nothing', async () => {
    h.failNextCreates(...Array.from({ length: 5 }, () => h.writeConflict()));

    const error = await bookOnline({ user: await newCustomer(), carId: h.createCar(), scheduledAt: SLOT }).catch((e) => e);

    expect(error).toMatchObject({ statusCode: 409, code: 'SLOT_FULL' });
    expect(error.errors.nearestSlots.length).toBeGreaterThan(0);
    expect(h.appointments.size).toBe(0);
  });

  test('an unexpected failure is not retried', async () => {
    h.failNextCreates(new Error('Disk full (simulated)'));
    await expect(bookOnline({ user: await newCustomer(), carId: h.createCar(), scheduledAt: SLOT })).rejects.toThrow('Disk full');
    expect(h.stats).toMatchObject({ aborted: 1, committed: 0 });
  });

  test('capacity from settings is respected when lowered', async () => {
    h.useSettings({ testDrive: { ...getDefaultBaseSettings().testDrive, maxGuestsPerSlot: 1 } });
    await bookOnline({ user: await newCustomer(1), carId: h.createCar(), scheduledAt: SLOT });
    await expect(bookOnline({ user: await newCustomer(2), carId: h.createCar(), scheduledAt: SLOT }))
      .rejects.toMatchObject({ code: 'SLOT_FULL' });
  });
});
