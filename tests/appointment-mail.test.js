/**
 * @file appointment-mail.test.js
 * @description The six customer e-mails: exact content, HTML escaping, no internal data,
 * and the fire-and-forget dispatcher (never blocks, never throws, one failure never
 * reaches the caller). The transport is a recording fake: nothing is ever really sent.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-028, REQ-029, C23, NFR-07; AC-28)
 */

import { jest } from '@jest/globals';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { buildMail, formatVnText, MailEvent } from '../src/services/appointmentMailTemplates.js';
import {
  dispatchMail, describeVisit, carTitle, awaitPendingMail,
} from '../src/services/appointmentMailService.js';

const fakes = await setupAppointmentFakes();
beforeEach(() => fakes.reset());

const SLOT = new Date('2026-11-10T03:00:00Z'); // Tuesday 10:00 in Vietnam
const OLD = new Date('2026-11-12T08:00:00Z'); // Thursday 15:00
const base = {
  customerName: 'Nguyễn An', visitCode: 'APT-0007', scheduledAt: SLOT, location: 'Showroom TrustCar, Quận 1',
  cars: ['MAZDA CX-5 2.0', 'TOYOTA Camry'],
};

describe('formatVnText', () => {
  it('shows Vietnam local time with the weekday', () => {
    expect(formatVnText(SLOT)).toBe('Thứ ba, 10:00 ngày 10/11/2026');
    expect(formatVnText('2026-11-10T17:30:00Z')).toBe('Thứ tư, 00:30 ngày 11/11/2026'); // crosses midnight in UTC+7
  });
});

describe('templates', () => {
  it.each([
    [MailEvent.CREATED, 'đã nhận lịch lái thử APT-0007', 'sẽ gọi điện để xác nhận'],
    [MailEvent.CONFIRMED, 'đã được xác nhận', 'Hẹn gặp bạn tại showroom'],
    [MailEvent.CANCELLED_BY_CUSTOMER, 'bạn đã hủy lịch lái thử APT-0007', 'theo yêu cầu của bạn'],
    [MailEvent.CANCELLED_BY_STAFF, 'showroom đã hủy lịch lái thử APT-0007', 'Xin lỗi vì sự bất tiện'],
    [MailEvent.CAR_UNAVAILABLE, 'có xe không còn khả dụng', 'đã được hủy tự động'],
    [MailEvent.RESCHEDULED, 'đã được đổi sang APT-0007', 'đã được <strong>đổi giờ</strong>'],
  ])('%s has the visit facts and its own wording', (event, subjectPart, bodyPart) => {
    const mail = buildMail(event, { ...base, previousVisitCode: 'APT-0003', previousScheduledAt: OLD });
    expect(mail.subject).toContain(subjectPart);
    expect(mail.html).toContain(bodyPart);
    expect(mail.html).toContain('Chào Nguyễn An');
    expect(mail.html).toContain('Thứ ba, 10:00 ngày 10/11/2026');
    expect(mail.html).toContain('APT-0007');
    expect(mail.html).toContain('MAZDA CX-5 2.0');
    expect(mail.preheader.length).toBeGreaterThan(10);
  });

  it('links to the customer visits page, or to the car catalogue when the visit is over', () => {
    expect(buildMail(MailEvent.CREATED, base).html).toContain('/lich-hen');
    expect(buildMail(MailEvent.CANCELLED_BY_STAFF, base).html).toContain('/xe');
  });

  it('a staff cancellation shows only the chosen reason label; the generic "other" label is not repeated', () => {
    const busy = buildMail(MailEvent.CANCELLED_BY_STAFF, { ...base, reasonLabel: 'Showroom có việc đột xuất' });
    expect(busy.html).toContain('Lý do: Showroom có việc đột xuất.');
    const other = buildMail(MailEvent.CANCELLED_BY_STAFF, { ...base, reasonLabel: 'Showroom đã hủy lịch hẹn của bạn' });
    expect(other.html).not.toContain('Lý do:');
  });

  it('never prints internal data even if the caller passes it (explicit allow-list)', () => {
    const mail = buildMail(MailEvent.CANCELLED_BY_STAFF, {
      ...base, note: 'GOI-2-LAN', cancellationNote: 'NOTE-NOI-BO', outcome: 'OUTCOME', staffName: 'NV-BI-MAT', floorPrice: 123456789,
    });
    expect(mail.html + mail.subject + mail.preheader).not.toMatch(/GOI-2-LAN|NOTE-NOI-BO|OUTCOME|NV-BI-MAT|123456789/);
  });

  it('escapes HTML in names, cars and reasons', () => {
    const mail = buildMail(MailEvent.CANCELLED_BY_STAFF, {
      ...base, customerName: '<script>alert(1)</script>', cars: ['<img src=x onerror=1>'], reasonLabel: 'A & B "C"',
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('A &amp; B &quot;C&quot;');
  });

  it('wording of an automatic cancellation depends on the car status and on what remains', () => {
    const reserved = buildMail(MailEvent.CAR_UNAVAILABLE, { ...base, cars: ['MAZDA CX-5'], carStatus: 'RESERVED', remainingCars: ['TOYOTA Camry'] });
    expect(reserved.html).toContain('đang được một khách hàng khác giữ chỗ');
    expect(reserved.html).toContain('vẫn được giữ nguyên');
    expect(reserved.html).toContain('TOYOTA Camry');
    const sold = buildMail(MailEvent.CAR_UNAVAILABLE, { ...base, cars: ['MAZDA CX-5'], carStatus: 'SOLD', remainingCars: [] });
    expect(sold.html).toContain('hiện không còn được bán');
    expect(sold.html).toContain('đã được hủy hoàn toàn');
  });

  it('a reschedule shows both times and codes, and asks for a new confirmation only when needed', () => {
    const data = { ...base, previousVisitCode: 'APT-0003', previousScheduledAt: OLD };
    const moved = buildMail(MailEvent.RESCHEDULED, { ...data, needsConfirmation: true });
    expect(moved.html).toContain('Thứ năm, 15:00 ngày 12/11/2026');
    expect(moved.html).toContain('APT-0003');
    expect(moved.html).toContain('xác nhận lại');
    expect(buildMail(MailEvent.RESCHEDULED, data).html).not.toContain('xác nhận lại');
  });

  it('rejects an unknown event', () => {
    expect(() => buildMail('NOPE', base)).toThrow('Unknown appointment mail event');
  });
});

describe('describeVisit / carTitle', () => {
  it('uses make, model, variant; falls back to the vehicle code', () => {
    expect(carTitle({ make: 'MAZDA', model: 'CX-5', variant: '2.0' })).toBe('MAZDA CX-5 2.0');
    expect(carTitle({ vehicleCode: 'TC-2026-0001' })).toBe('TC-2026-0001');
    expect(carTitle(undefined)).toBe('Xe');
  });

  it('builds the visit data from exactly the rows given', () => {
    const car = fakes.addCar({ make: 'MAZDA', model: 'CX-5', variant: '2.0' });
    const rows = [{ _id: 'a', appointmentCode: 'APT-0009', car: car._id, scheduledAt: SLOT, location: 'L' }];
    expect(describeVisit(rows, new Map([[String(car._id), car]]))).toEqual({
      visitCode: 'APT-0009', scheduledAt: SLOT, location: 'L', cars: ['MAZDA CX-5 2.0'],
    });
  });
});

describe('dispatchMail (REQ-029, NFR-07)', () => {
  const job = (customer) => ({ event: MailEvent.CONFIRMED, customerId: customer._id, data: { ...base } });
  let quietError;
  let quietWarn;
  beforeEach(() => {
    quietError = jest.spyOn(console, 'error').mockImplementation(() => {});
    quietWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { quietError.mockRestore(); quietWarn.mockRestore(); });

  it('sends to the customer address with the built e-mail', async () => {
    const customer = fakes.addCustomer({ fullName: 'Nguyễn An', email: 'an@example.com' });
    dispatchMail(job(customer));
    const sent = await fakes.flushMail();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'an@example.com', toName: 'Nguyễn An' });
    expect(sent[0].subject).toContain('đã được xác nhận');
    expect(sent[0].html).toContain('Chào Nguyễn An');
  });

  it('returns at once even when the provider takes a long time (does not block the request)', async () => {
    fakes.mail.delayMs = 400;
    const customer = fakes.addCustomer();
    const started = Date.now();
    const result = dispatchMail(job(customer));
    expect(Date.now() - started).toBeLessThan(100);
    expect(result).toBeUndefined();
    expect(fakes.mail.sent).toHaveLength(0);
    await awaitPendingMail();
    expect(fakes.mail.sent).toHaveLength(1);
  });

  it('a customer without an e-mail address is skipped and logged, never an error', async () => {
    const customer = fakes.addCustomer({ email: undefined });
    delete customer.email;
    expect(() => dispatchMail(job(customer))).not.toThrow();
    expect(await fakes.flushMail()).toHaveLength(0);
    expect(quietWarn).toHaveBeenCalledWith(expect.stringContaining('no e-mail address'));
  });

  it('a missing customer is handled the same way', async () => {
    dispatchMail({ event: MailEvent.CREATED, customerId: fakes.addCar()._id, data: base });
    expect(await fakes.flushMail()).toHaveLength(0);
  });

  it('a provider failure is only logged: no throw, no address or content in the log', async () => {
    fakes.mail.fail = true;
    const customer = fakes.addCustomer({ email: 'secret-address@example.com' });
    expect(() => dispatchMail(job(customer))).not.toThrow();
    await awaitPendingMail();
    expect(quietError).toHaveBeenCalledWith(expect.stringContaining('e-mail failed (CONFIRMED)'), 'SMTP unavailable (simulated)');
    expect(JSON.stringify(quietError.mock.calls)).not.toContain('secret-address');
  });

  it('a template problem is contained too', async () => {
    const customer = fakes.addCustomer();
    expect(() => dispatchMail({ event: 'NOPE', customerId: customer._id, data: base })).not.toThrow();
    await awaitPendingMail();
    expect(quietError).toHaveBeenCalled();
    expect(fakes.mail.sent).toHaveLength(0);
  });

  it('awaitPendingMail waits for every dispatched mail', async () => {
    fakes.mail.delayMs = 50;
    const customers = [fakes.addCustomer(), fakes.addCustomer(), fakes.addCustomer()];
    customers.forEach((customer) => dispatchMail(job(customer)));
    await awaitPendingMail();
    expect(fakes.mail.sent).toHaveLength(3);
  });
});
