/**
 * @file appointment-mail-events.test.js
 * @description The e-mails really go out at the right moments: booking, customer cancel,
 * staff confirm and staff cancel (exactly one per event, only after the change succeeded,
 * never for COMPLETED / NO_SHOW, never leaking the staff note), and a mail problem never
 * changes the outcome of the request. Nothing is ever really sent.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-016, 019, 028, 029; INV-12; AC-28)
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { createVisit } from '../src/services/appointmentBookingService.js';
import { cancelMyVisit } from '../src/services/appointmentCustomerService.js';
import { changeVisitStatus } from '../src/services/appointmentStaffService.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';

const fakes = await setupAppointmentFakes();
jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const NOW = new Date('2026-11-08T00:00:00Z');
const SLOT = new Date('2026-11-10T03:00:00Z'); // Tuesday 10:00 VN
const AFTER = new Date(SLOT.getTime() + 3600e3);
const userId = new mongoose.Types.ObjectId();
let customer;
let staff;

beforeEach(() => {
  fakes.reset();
  customer = fakes.addCustomer({ fullName: 'Nguyễn An', email: 'an@example.com' });
  staff = fakes.addUser({ fullName: 'Lan Sales' });
});

const reject = (promise) => promise.then(() => null, (error) => error);
const car = (extra = {}) => fakes.addCar({ make: 'MAZDA', model: 'CX-5', variant: `V${fakes.appointments.length}${Math.random()}`, ...extra });
const visit = (n = 1, extra = {}) =>
  Array.from({ length: n }, () => fakes.addAppointment({
    customer: customer._id, car: car()._id, scheduledAt: SLOT, createdBy: userId, createdAt: NOW, ...extra,
  }));
const book = (carIds, extra = {}) => createVisit({ userId, customerId: customer._id, carIds, scheduledAt: SLOT, now: NOW, ...extra });
const staffChange = (extra = {}) => changeVisitStatus({ id: fakes.appointments[0]._id, userId: staff._id, status: 'CONFIRMED', now: NOW, ...extra });
const cancelAsCustomer = (extra = {}) => cancelMyVisit({ customerId: customer._id, userId, id: fakes.appointments[0]._id, now: NOW, ...extra });

describe('booking', () => {
  it('sends one "received" e-mail listing the cars, after the rows exist', async () => {
    const a = car(); const b = car();
    await book([String(a._id), String(b._id)]);
    const sent = await fakes.flushMail();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'an@example.com', toName: 'Nguyễn An' });
    expect(sent[0].subject).toBe('TrustCar: đã nhận lịch lái thử APT-0001');
    expect(sent[0].html).toContain('Thứ ba, 10:00 ngày 10/11/2026');
    expect(sent[0].html).toContain('sẽ gọi điện để xác nhận');
    expect((sent[0].html.match(/<li>/g) ?? [])).toHaveLength(2);
  });

  it('sends nothing when the booking is refused', async () => {
    const a = car();
    expect(await reject(book([String(a._id)], { scheduledAt: new Date('2026-11-08T01:00:00Z') }))).not.toBeNull(); // too soon
    expect(await reject(book([String(new mongoose.Types.ObjectId())]))).not.toBeNull(); // unknown car
    expect(await fakes.flushMail()).toHaveLength(0);
  });

  it('a mail problem does not change the booking result', async () => {
    fakes.mail.fail = true;
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const a = car();
    const created = await book([String(a._id)]);
    await fakes.flushMail();
    expect(created.status).toBe('PENDING');
    expect(fakes.appointments).toHaveLength(1);
    quiet.mockRestore();
  });
});

describe('customer cancel', () => {
  it('sends one cancellation e-mail with the code shown on screen and only the cancelled cars', async () => {
    visit(2);
    visit(0);
    const dto = await cancelAsCustomer({ reason: 'bận' });
    const sent = await fakes.flushMail();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe(`TrustCar: bạn đã hủy lịch lái thử ${dto.visitCode}`);
    expect((sent[0].html.match(/<li>/g) ?? [])).toHaveLength(2);
    expect(sent[0].html).not.toContain('bận'); // the customer's own words are not echoed
  });

  it('uses the whole visit for the code and lists only the cars that were still open', async () => {
    visit(1, { status: 'CANCELLED', cancellationReason: 'AUTO_CAR_UNAVAILABLE:SOLD' }); // APT smallest, already closed
    visit(1);
    const dto = await cancelMyVisit({ customerId: customer._id, userId, id: fakes.appointments[1]._id, now: NOW });
    const sent = await fakes.flushMail();
    expect(sent[0].subject).toContain(dto.visitCode);
    expect((sent[0].html.match(/<li>/g) ?? [])).toHaveLength(1);
  });

  it('a second cancellation (409) and a refused one send nothing more', async () => {
    visit(1);
    await cancelAsCustomer();
    expect(await reject(cancelAsCustomer())).not.toBeNull();
    expect(await reject(cancelAsCustomer({ reason: 'RACE_LOST' }))).not.toBeNull();
    expect(await fakes.flushMail()).toHaveLength(1);
  });
});

describe('staff confirm / cancel / complete / no-show', () => {
  it('confirming sends one "confirmed" e-mail', async () => {
    visit(2);
    await staffChange();
    const sent = await fakes.flushMail();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('đã được xác nhận');
  });

  it('cancelling sends the label of the chosen reason and never the internal note', async () => {
    visit(1);
    await staffChange({ status: 'CANCELLED', reasonCode: 'CUSTOMER_WILL_NOT_COME', reason: 'GOI-2-LAN-KHONG-BAT-MAY' });
    const sent = await fakes.flushMail();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('showroom đã hủy lịch lái thử');
    expect(sent[0].html).toContain('Lý do: Bạn đã báo không thể đến.');
    expect(sent[0].html + sent[0].subject).not.toContain('GOI-2-LAN');
  });

  it('the generic reason (OTHER) says nothing about the reason', async () => {
    visit(1);
    await staffChange({ status: 'CANCELLED', reason: 'ly do rieng' });
    const [mail] = await fakes.flushMail();
    expect(mail.html).not.toContain('Lý do:');
    expect(mail.html).not.toContain('ly do rieng');
  });

  it.each([['COMPLETED'], ['NO_SHOW']])('%s sends no e-mail', async (status) => {
    visit(1, { status: 'CONFIRMED' });
    await staffChange({ status, now: AFTER });
    expect(await fakes.flushMail()).toHaveLength(0);
  });

  it('an invalid change sends nothing and a lost compare-and-set sends nothing', async () => {
    visit(1);
    expect(await reject(staffChange({ status: 'COMPLETED' }))).not.toBeNull();
    const { default: Appointment } = await import('../src/models/Appointment.js');
    Appointment.updateMany.mockImplementationOnce(async () => ({ modifiedCount: 0 }));
    expect(await reject(staffChange())).not.toBeNull();
    expect(await fakes.flushMail()).toHaveLength(0);
  });

  it('a mail failure or a customer without an address does not change the result', async () => {
    visit(1);
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    fakes.mail.fail = true;
    expect((await staffChange()).status).toBe('CONFIRMED');
    await fakes.flushMail();
    delete customer.email;
    fakes.mail.fail = false;
    expect((await staffChange({ status: 'CANCELLED', reasonCode: 'SHOWROOM_BUSY' })).status).toBe('CANCELLED');
    expect(await fakes.flushMail()).toHaveLength(0);
    quiet.mockRestore(); warn.mockRestore();
  });
});
