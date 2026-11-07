/**
 * @file test-drive-customer.test.js
 * @description A customer's own test drives: listing and cancelling.
 */

import { setupTestDriveHarness } from './helpers/fakeTestDriveModels.js';

const h = await setupTestDriveHarness();
const { default: mongoose } = await import('mongoose');
const { cancelMine, listMine } = await import('../src/services/testDriveCustomerService.js');

const FUTURE = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000);
const PAGE = { page: 1, limit: 20, skip: 0 };

let user;
let otherUser;

beforeEach(async () => {
  h.reset();
  const customer = await h.createCustomer();
  const otherCustomer = await h.createCustomer({ phone: '0907654321' });
  user = { _id: new mongoose.Types.ObjectId(), email: 'k@trustcar.vn', customer };
  otherUser = { _id: new mongoose.Types.ObjectId(), email: 'o@trustcar.vn', customer: otherCustomer };
});

const book = (overrides = {}) => h.insertAppointment({
  appointmentCode: `APT-${h.appointments.size + 1}`, customer: user.customer, car: h.createCar(), assignedTo: new mongoose.Types.ObjectId(),
  scheduledAt: FUTURE, slotSeat: 1, ...overrides,
});

describe('cancelMine', () => {
  test('cancels before the appointment, frees the seat, and counts as a booking used', async () => {
    const id = book();
    const view = await cancelMine(user, id);
    expect(view.status).toBe('CANCELLED');
    expect(view.cancellationReason).toBe('Khách hủy lịch');
    expect(h.appointment(id).slotSeat).toBeUndefined();
    expect(h.appointments.has(id)).toBe(true);
    expect(h.mail.sent).toHaveLength(0);
  });

  test('after the scheduled time gives 409', async () => {
    await expect(cancelMine(user, book({ scheduledAt: PAST }))).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_TRANSITION' });
  });

  test('an already closed appointment gives 409', async () => {
    await expect(cancelMine(user, book({ status: 'COMPLETED', slotSeat: undefined }))).rejects.toMatchObject({ statusCode: 409 });
  });

  test("another customer's appointment reads as not found and is not touched", async () => {
    const id = book();
    await expect(cancelMine(otherUser, id)).rejects.toMatchObject({ statusCode: 404, code: 'TEST_DRIVE_NOT_FOUND' });
    expect(h.appointment(id).status).toBe('PENDING');
  });
});

describe('listMine', () => {
  test('shows only their own appointments, without internal fields', async () => {
    const carId = h.createCar({ make: 'Honda', model: 'City', year: 2022 });
    const id = book({ car: carId });
    await cancelMine(user, id);
    book({ customer: otherUser.customer, scheduledAt: new Date(FUTURE.getTime() + 3600000) });

    const { items, pagination } = await listMine(user, PAGE);

    expect(pagination.total).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id, status: 'CANCELLED', cancellationReason: 'Khách hủy lịch', car: { id: carId, make: 'HONDA', model: 'City', year: 2022 } });
    ['assignedTo', 'createdBy', 'updatedBy', 'slotSeat', 'reminderSentAt', 'customer'].forEach((field) => {
      expect(items[0]).not.toHaveProperty(field);
    });
    expect(items[0].car).not.toHaveProperty('status');
  });

  test('pages results', async () => {
    book();
    book({ scheduledAt: new Date(FUTURE.getTime() + 3600000), slotSeat: 2 });
    const { items, pagination } = await listMine(user, { page: 2, limit: 1, skip: 1 });
    expect(items).toHaveLength(1);
    expect(pagination.total).toBe(2);
  });

  test('an account without a profile has nothing to list', async () => {
    const { items } = await listMine({ _id: new mongoose.Types.ObjectId() }, PAGE);
    expect(items).toEqual([]);
  });
});
