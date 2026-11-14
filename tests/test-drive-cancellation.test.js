/**
 * @file test-drive-cancellation.test.js
 * @description Cancelling an appointment: the seat comes back once, the audit entry
 * is written, and email problems never fail the cancellation.
 */

import { setupTestDriveHarness } from './helpers/fakeTestDriveModels.js';

const h = await setupTestDriveHarness();
const { default: mongoose } = await import('mongoose');
const { cancelAppointment } = await import('../src/services/testDriveCancellation.js');
const { findCustomerRecipient, maskEmail } = await import('../src/services/testDriveMail.js');

const AT = new Date('2026-11-10T02:00:00.000Z');
const actor = { _id: new mongoose.Types.ObjectId(), email: 'staff@trustcar.vn' };

let customer;
let id;

beforeEach(async () => {
  h.reset();
  customer = await h.createCustomer({ email: 'profile@trustcar.vn' });
  id = h.insertAppointment({ appointmentCode: 'APT-0001', customer, car: h.createCar(), assignedTo: new mongoose.Types.ObjectId(), scheduledAt: AT, slotSeat: 1, durationMinutes: 60 });
});

describe('cancelAppointment', () => {
  test('cancels, frees the seat, stores the reason, audits and emails', async () => {
    const cancelled = await cancelAppointment({ filter: { _id: id }, reason: 'Khách hủy lịch', actor });

    expect(cancelled.status).toBe('CANCELLED');
    const stored = h.appointment(id);
    expect(stored.slotSeat).toBeUndefined();
    expect(stored.cancellationReason).toBe('Khách hủy lịch');
    expect(h.activity).toEqual([expect.objectContaining({ eventType: 'APPOINTMENT_CANCELLED', performedBy: actor._id, targetCode: 'APT-0001' })]);
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0].to).toBe('profile@trustcar.vn');
    expect(h.mail.sent[0].html).toContain('Khách hủy lịch');
    expect(h.mail.sent[0].html).toContain('09:00 ngày 10/11/2026');
  });

  test('the freed seat can be taken again by the same car', async () => {
    const stored = h.appointment(id);
    await cancelAppointment({ filter: { _id: id }, reason: 'x', actor, notify: false });
    expect(() => h.insertAppointment({ customer, car: stored.car, assignedTo: stored.assignedTo, scheduledAt: AT, slotSeat: 1 })).not.toThrow();
  });

  test('a second cancellation changes nothing and sends no second email', async () => {
    const results = await Promise.all([
      cancelAppointment({ filter: { _id: id }, reason: 'first', actor }),
      cancelAppointment({ filter: { _id: id }, reason: 'second', actor: null }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(h.activity).toHaveLength(1);
    expect(h.mail.sent).toHaveLength(1);
  });

  test.each(['COMPLETED', 'NO_SHOW', 'CANCELLED'])('a %s appointment is not cancelled', async (status) => {
    h.appointment(id).status = status;
    expect(await cancelAppointment({ filter: { _id: id }, reason: 'x', actor })).toBeNull();
    expect(h.appointment(id).status).toBe(status);
    expect(h.mail.sent).toHaveLength(0);
  });

  test('a write conflict with another action retries, then sees the result', async () => {
    const real = h.Appointment.findOneAndUpdate.getMockImplementation();
    h.Appointment.findOneAndUpdate.mockImplementationOnce(() => { throw h.writeConflict(); });

    const cancelled = await cancelAppointment({ filter: { _id: id }, reason: 'x', actor });

    expect(cancelled.status).toBe('CANCELLED');
    expect(h.stats).toMatchObject({ aborted: 1, committed: 1 });
    expect(h.activity).toHaveLength(1);
    h.Appointment.findOneAndUpdate.mockImplementation(real);
  });

  test('a failed email still cancels', async () => {
    h.mail.fail = true;
    const cancelled = await cancelAppointment({ filter: { _id: id }, reason: 'x', actor });
    expect(cancelled.status).toBe('CANCELLED');
    expect(h.appointment(id).status).toBe('CANCELLED');
  });

  test('no email address means no email and no error', async () => {
    const noEmail = await h.createCustomer({ phone: '0907654321' });
    const other = h.insertAppointment({ appointmentCode: 'APT-0002', customer: noEmail, car: h.createCar(), scheduledAt: AT, slotSeat: 2 });
    await expect(cancelAppointment({ filter: { _id: other }, reason: 'x', actor })).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(h.mail.sent).toHaveLength(0);
  });
});

describe('recipient', () => {
  test('prefers the account email over the profile email', async () => {
    await h.createUser({ roleName: 'CUSTOMER', customer, email: 'account@trustcar.vn', phone: '0901234567' });
    await expect(findCustomerRecipient(customer)).resolves.toMatchObject({ email: 'account@trustcar.vn' });
  });

  test('log masking hides the address', () => {
    expect(maskEmail('khach@gmail.com')).toBe('k***@gmail.com');
  });
});
