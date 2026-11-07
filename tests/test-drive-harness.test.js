/**
 * @file test-drive-harness.test.js
 * @description Checks that the model declares the unique indexes the booking code
 * relies on, and that the in-memory harness emulates them the same way.
 */

import { setupTestDriveHarness } from './helpers/fakeTestDriveModels.js';

const h = await setupTestDriveHarness();
const { default: mongoose } = await import('mongoose');

const AT = new Date('2026-11-10T02:00:00.000Z');
const id = () => new mongoose.Types.ObjectId();
const held = (overrides = {}) => ({ customer: id(), car: id(), assignedTo: id(), scheduledAt: AT, slotSeat: 1, ...overrides });

beforeEach(() => h.reset());

describe('Appointment schema', () => {
  test('declares the three partial unique indexes on seat holders', () => {
    const indexes = h.Appointment.schema.indexes();
    const named = (name) => indexes.find(([, options]) => options.name === name);

    expect(named('uniq_seat_car_time')[0]).toEqual({ car: 1, scheduledAt: 1 });
    expect(named('uniq_seat_staff_time')[0]).toEqual({ assignedTo: 1, scheduledAt: 1 });
    expect(named('uniq_seat_number_time')[0]).toEqual({ scheduledAt: 1, slotSeat: 1 });
    ['uniq_seat_car_time', 'uniq_seat_staff_time', 'uniq_seat_number_time'].forEach((name) => {
      expect(named(name)[1]).toMatchObject({ unique: true, partialFilterExpression: { slotSeat: { $type: 'number' } } });
    });
  });

  test('new fields are optional, so older documents stay valid', () => {
    const doc = new h.Appointment({ customer: id(), car: id(), type: 'TEST_DRIVE', scheduledAt: AT, createdBy: id() });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.slotSeat).toBeUndefined();
    expect(doc.reminderSentAt).toBeUndefined();
  });

  test('rejects a seat number below 1', () => {
    const doc = new h.Appointment({ customer: id(), car: id(), type: 'TEST_DRIVE', scheduledAt: AT, createdBy: id(), slotSeat: 0 });
    expect(doc.validateSync().errors.slotSeat).toBeDefined();
  });
});

describe('harness unique indexes', () => {
  test.each([
    ['same car', (first) => ({ car: first.car, slotSeat: 2 })],
    ['same staff', (first) => ({ assignedTo: first.assignedTo, slotSeat: 2 })],
    ['same seat', () => ({ slotSeat: 1 })],
  ])('a second holder with the %s at the same time is refused', (_name, clash) => {
    const first = held();
    h.insertAppointment(first);
    expect(() => h.insertAppointment(held(clash(first)))).toThrow(/E11000/);
  });

  test('documents without a seat are outside the indexes', () => {
    const first = held();
    h.insertAppointment(first);
    expect(() => h.insertAppointment({ ...first, slotSeat: undefined, assignedTo: undefined })).not.toThrow();
  });

  test('removing the seat frees the car for another booking', async () => {
    const first = held();
    const firstId = h.insertAppointment(first);
    await h.Appointment.findOneAndUpdate({ _id: firstId }, { $unset: { slotSeat: 1 } });
    expect(() => h.insertAppointment(held({ car: first.car }))).not.toThrow();
  });

  test('a conditional update matches only the expected status, and null matches a missing field', async () => {
    const firstId = h.insertAppointment(held());
    expect(await h.Appointment.findOneAndUpdate({ _id: firstId, status: 'CONFIRMED' }, { $set: { status: 'CANCELLED' } })).toBeNull();
    const claimed = await h.Appointment.findOneAndUpdate({ _id: firstId, reminderSentAt: null }, { $set: { reminderSentAt: AT } }, { new: true });
    expect(claimed.reminderSentAt).toEqual(AT);
    expect(await h.Appointment.findOneAndUpdate({ _id: firstId, reminderSentAt: null }, { $set: { reminderSentAt: AT } })).toBeNull();
  });

  test('an aborted transaction leaves no trace', async () => {
    const session = await mongoose.startSession();
    session.startTransaction();
    await h.Appointment.create([held({ createdBy: id(), type: 'TEST_DRIVE', appointmentCode: 'APT-0001' })], { session });
    await session.abortTransaction();
    await session.endSession();
    expect(h.appointments.size).toBe(0);
  });
});
