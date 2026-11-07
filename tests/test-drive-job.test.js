/**
 * @file test-drive-job.test.js
 * @description The periodic scan: reminder emails and cancelling appointments of
 * cars no longer for sale.
 */

import { setupTestDriveHarness } from './helpers/fakeTestDriveModels.js';

const h = await setupTestDriveHarness();
const { jest } = await import('@jest/globals');
const { default: mongoose } = await import('mongoose');
const { runTestDriveJobOnce, startTestDriveJob, stopTestDriveJob } = await import('../src/jobs/testDriveJob.js');

const MINUTE = 60 * 1000;
const inMinutes = (minutes) => new Date(Date.now() + minutes * MINUTE);

let customer;

beforeEach(async () => {
  h.reset();
  customer = await h.createCustomer({ email: 'khach@trustcar.vn' });
});

const book = (overrides = {}) => h.insertAppointment({
  appointmentCode: `APT-${h.appointments.size + 1}`, customer, car: h.createCar(), assignedTo: new mongoose.Types.ObjectId(),
  scheduledAt: inMinutes(50), slotSeat: h.appointments.size + 1, location: 'Showroom TrustCar', ...overrides,
});

describe('reminders', () => {
  test('nothing is sent 2 hours ahead', async () => {
    book({ scheduledAt: inMinutes(120) });
    await runTestDriveJobOnce();
    expect(h.mail.sent).toHaveLength(0);
  });

  test('sent once within the hour, however often the job runs', async () => {
    const id = book();
    await runTestDriveJobOnce();
    await runTestDriveJobOnce();
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0].to).toBe('khach@trustcar.vn');
    expect(h.mail.sent[0].subject).toContain('Nhắc lịch');
    expect(h.mail.sent[0].html).toContain('Showroom TrustCar');
    expect(h.appointment(id).reminderSentAt).toBeInstanceOf(Date);
  });

  test('overlapping scans still send once', async () => {
    book();
    await Promise.all([runTestDriveJobOnce(), runTestDriveJobOnce()]);
    expect(h.mail.sent).toHaveLength(1);
  });

  test('both PENDING and CONFIRMED get one', async () => {
    book({ status: 'PENDING' });
    book({ status: 'CONFIRMED' });
    await runTestDriveJobOnce();
    expect(h.mail.sent).toHaveLength(2);
  });

  test.each(['CANCELLED', 'COMPLETED', 'NO_SHOW'])('a %s appointment gets none', async (status) => {
    book({ status, slotSeat: undefined });
    await runTestDriveJobOnce();
    expect(h.mail.sent).toHaveLength(0);
  });

  test('other appointment types get none', async () => {
    book({ type: 'VIEWING' });
    await runTestDriveJobOnce();
    expect(h.mail.sent).toHaveLength(0);
  });

  test('a failure keeps the appointment and the next scan retries', async () => {
    const id = book();
    h.mail.fail = true;
    await runTestDriveJobOnce();
    expect(h.appointment(id).status).toBe('PENDING');
    expect(h.appointment(id).reminderSentAt).toBeUndefined();

    h.mail.fail = false;
    await runTestDriveJobOnce();
    await runTestDriveJobOnce();
    expect(h.mail.sent).toHaveLength(1);
  });

  test('no retry once the appointment has started', async () => {
    book({ scheduledAt: inMinutes(-1) });
    await runTestDriveJobOnce();
    expect(h.mail.sent).toHaveLength(0);
  });

  test('a drive that starts during the batch is not reminded', async () => {
    const id = book({ scheduledAt: inMinutes(50) });
    const realFind = h.Appointment.find.getMockImplementation();
    // The appointment is selected as due, then its time passes before it is claimed.
    h.Appointment.find.mockImplementationOnce((filter) => {
      const selected = realFind(filter);
      h.appointment(id).scheduledAt = inMinutes(-1);
      return selected;
    });
    await runTestDriveJobOnce();
    expect(h.mail.sent).toHaveLength(0);
  });

  test('one failed cancellation does not stop the rest of the batch', async () => {
    const carId = h.createCar({ status: 'SOLD' });
    const first = book({ car: carId, scheduledAt: inMinutes(300) });
    const second = book({ car: carId, scheduledAt: inMinutes(400) });
    h.Appointment.findOneAndUpdate.mockImplementationOnce(() => { throw new Error('Simulated failure'); });
    await runTestDriveJobOnce();
    const statuses = [h.appointment(first).status, h.appointment(second).status].sort();
    expect(statuses).toEqual(['CANCELLED', 'PENDING']);
  });

  test('a customer without email is skipped without affecting others', async () => {
    const noEmail = await h.createCustomer({ phone: '0907654321' });
    const skipped = book({ customer: noEmail });
    book();
    await runTestDriveJobOnce();
    expect(h.mail.sent).toHaveLength(1);
    expect(h.appointment(skipped).status).toBe('PENDING');
  });

  test('never cancels an appointment for lack of a reply', async () => {
    const id = book({ scheduledAt: inMinutes(10), reminderSentAt: inMinutes(-50) });
    await runTestDriveJobOnce();
    expect(h.appointment(id).status).toBe('PENDING');
  });
});

describe('cars no longer for sale', () => {
  test.each(['SOLD', 'DELISTED'])('an upcoming appointment of a %s car is cancelled, freed and emailed', async (status) => {
    const id = book({ car: h.createCar({ status }), scheduledAt: inMinutes(300) });
    await runTestDriveJobOnce();
    const stored = h.appointment(id);
    expect(stored.status).toBe('CANCELLED');
    expect(stored.slotSeat).toBeUndefined();
    expect(stored.cancellationReason).toBe('Xe không còn sẵn sàng để lái thử');
    expect(h.activity).toEqual([expect.objectContaining({ eventType: 'APPOINTMENT_CANCELLED', performedBy: null })]);
    expect(h.mail.sent).toHaveLength(1);
  });

  test.each(['RESERVED', 'MAINTENANCE'])('a %s car keeps its appointment', async (status) => {
    const id = book({ car: h.createCar({ status }), scheduledAt: inMinutes(300) });
    await runTestDriveJobOnce();
    expect(h.appointment(id).status).toBe('PENDING');
  });

  test('a past appointment is left alone', async () => {
    const id = book({ car: h.createCar({ status: 'SOLD' }), scheduledAt: inMinutes(-60) });
    await runTestDriveJobOnce();
    expect(h.appointment(id).status).toBe('PENDING');
  });

  test('racing a manual cancellation gives back the seat once and sends one email', async () => {
    const { cancelAppointment } = await import('../src/services/testDriveCancellation.js');
    const id = book({ car: h.createCar({ status: 'SOLD' }), scheduledAt: inMinutes(300) });

    await Promise.all([runTestDriveJobOnce(), cancelAppointment({ filter: { _id: id }, reason: 'Nhân viên hủy', actor: { _id: new mongoose.Types.ObjectId() } })]);

    expect(h.appointment(id).status).toBe('CANCELLED');
    expect(h.activity).toHaveLength(1);
    expect(h.mail.sent).toHaveLength(1);
  });
});

describe('scheduling', () => {
  test('a failing step is logged and does not stop the other or throw', async () => {
    const spy = jest.spyOn(h.Appointment, 'distinct').mockImplementationOnce(() => { throw new Error('DB down (simulated)'); });
    book();
    await expect(runTestDriveJobOnce()).resolves.toBeUndefined();
    expect(h.mail.sent).toHaveLength(1);
    expect(spy).toHaveBeenCalled();
  });

  test('keeps a single timer and stops on request', async () => {
    jest.useFakeTimers();
    try {
      book();
      startTestDriveJob();
      startTestDriveJob(); // A second start must not add a second timer.
      expect(jest.getTimerCount()).toBe(1);
      stopTestDriveJob();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
