/**
 * @file appointment-reschedule.test.js
 * @description Rescheduling a visit: a customer (≥ 12 h ahead, at most twice) and staff (any
 * time, the "he forgot to tell us" case). The old visit stays untouched until the new one is
 * proven; every refusal leaves the data exactly as it was. Concurrency and undo are in
 * appointment-reschedule-race.test.js.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-031…034, 041; C16–C18, C27, C29; AC-30…33, AC-38)
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { rescheduleMyVisit, rescheduleVisitAsStaff } from '../src/services/appointmentRescheduleService.js';
import { getMyVisit, listMyVisits } from '../src/services/appointmentCustomerService.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';

const fakes = await setupAppointmentFakes();
const logSpy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const NOW = new Date('2026-11-08T00:00:00Z');
const OLD = new Date('2026-11-12T03:00:00Z'); // Thu 10:00 VN
const NEW = new Date('2026-11-13T06:00:00Z'); // Fri 13:00 VN
const userId = new mongoose.Types.ObjectId();
const staffId = new mongoose.Types.ObjectId();
let me;
let rival;

beforeEach(() => {
  fakes.reset(); logSpy.mockClear();
  me = fakes.addCustomer({ fullName: 'Nguyễn An', email: 'an@example.com' });
  rival = fakes.addCustomer({ fullName: 'Khách Khác' });
  fakes.addUser({ _id: staffId, fullName: 'Lan Sales' });
});

const row = (who, scheduledAt, extra = {}) =>
  fakes.addAppointment({ customer: who._id, car: fakes.addCar()._id, scheduledAt, createdBy: userId, createdAt: NOW, ...extra });
const myVisit = (n = 1, extra = {}) => Array.from({ length: n }, () => row(me, OLD, extra));
const reject = (promise) => promise.then(() => null, (error) => error);
const snapshot = () => JSON.stringify(fakes.appointments);
const move = (extra = {}) => rescheduleMyVisit({
  customerId: me._id, userId, id: fakes.appointments[0]._id, scheduledAt: NEW, now: NOW, ...extra,
});
const moveByStaff = (extra = {}) => rescheduleVisitAsStaff({
  id: fakes.appointments[0]._id, userId: staffId, scheduledAt: NEW, now: NOW, ...extra,
});
const visible = () => fakes.appointments.filter((r) => r.isActive);
const hidden = () => fakes.appointments.filter((r) => !r.isActive);

describe('customer reschedule: the happy path (AC-30)', () => {
  it('creates PENDING appointments for the same cars at the new time and hides the old ones', async () => {
    const [a, b] = myVisit(2, { status: 'CONFIRMED', assignedTo: staffId, confirmedBy: staffId, confirmedAt: NOW });
    const oldCode = a.appointmentCode;
    const { visit, previousVisitCode } = await move();

    expect(previousVisitCode).toBe(oldCode);
    expect(visit).toMatchObject({ status: 'PENDING', scheduledAt: NEW.toISOString(), notes: a.notes });
    expect(visit.visitCode).not.toBe(oldCode); // Spec C16: a new code
    expect(visit.appointments.map((x) => x.car._id).sort()).toEqual([String(a.car), String(b.car)].sort());

    const created = visible();
    expect(created).toHaveLength(2);
    created.forEach((r) => {
      expect(r).toMatchObject({ status: 'PENDING', type: 'TEST_DRIVE', durationMinutes: 90, assignedTo: null, confirmedBy: null });
      expect(r.scheduledAt).toEqual(NEW);
      expect(String(r.createdBy)).toBe(String(userId));
    });
    hidden().forEach((r) => {
      expect(r).toMatchObject({ status: 'CANCELLED', isActive: false, cancellationReason: `RESCHEDULED:${visit.visitCode}` });
      expect(String(r.updatedBy)).toBe(String(userId));
    });
    expect(hidden()).toHaveLength(2);
  });

  it('the old visit disappears from every customer API; only the new one is listed', async () => {
    const [a] = myVisit(1);
    const { visit } = await move();
    expect((await reject(getMyVisit({ customerId: me._id, id: a._id }))).code).toBe('APPOINTMENT_NOT_FOUND');
    const { visits } = await listMyVisits({ customerId: me._id });
    expect(visits.map((v) => v.visitId)).toEqual([visit.visitId]);
  });

  it('writes exactly one APPOINTMENT_RESCHEDULED and no cancellation entry (AC-38)', async () => {
    const [a] = myVisit(2);
    const { visit } = await move({ ipAddress: '9.9.9.9' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatchObject({
      eventType: 'APPOINTMENT_RESCHEDULED', performedBy: userId, targetCode: visit.visitCode, ipAddress: '9.9.9.9',
      metadata: { previousVisitCode: a.appointmentCode },
    });
  });

  it('a customer who already holds 2 open visits can still move one (the moving visit is not counted twice)', async () => {
    myVisit(1);
    row(me, new Date('2026-11-14T03:00:00Z'));
    const { visit } = await move();
    expect(visit.status).toBe('PENDING');
    expect(visible().filter((r) => ['PENDING', 'CONFIRMED'].includes(r.status))).toHaveLength(2);
  });

  it('sends one e-mail with both times and both codes, asking for a new confirmation', async () => {
    const [a] = myVisit(1, { status: 'CONFIRMED' });
    const { visit } = await move();
    const sent = await fakes.flushMail();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain(visit.visitCode);
    expect(sent[0].html).toContain('Thứ năm, 10:00 ngày 12/11/2026');
    expect(sent[0].html).toContain('Thứ sáu, 13:00 ngày 13/11/2026');
    expect(sent[0].html).toContain(a.appointmentCode);
    expect(sent[0].html).toContain('xác nhận lại');
  });

  it('leaves an auto-cancelled appointment of the old visit where it was (C29)', async () => {
    const closed = row(me, OLD, { status: 'CANCELLED', cancellationReason: 'AUTO_CAR_UNAVAILABLE:SOLD' });
    const open = row(me, OLD);
    const { visit } = await move({ id: open._id });
    expect(visit.appointments).toHaveLength(1);
    expect(closed).toMatchObject({ isActive: true, status: 'CANCELLED' });
    expect(open.isActive).toBe(false);
  });

  it('a mail failure never changes the outcome', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    fakes.mail.fail = true;
    myVisit(1);
    expect((await move()).visit.status).toBe('PENDING');
    await fakes.flushMail();
    quiet.mockRestore();
  });
});

describe('customer reschedule: refusals leave everything as it was (AC-31)', () => {
  const expectRefused = async (promise, code) => {
    const before = snapshot();
    const error = await reject(promise);
    expect(error?.code).toBe(code);
    expect(snapshot()).toBe(before);
    expect(await fakes.flushMail()).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalled();
  };

  it('under 12 hours to go → 409 APPOINTMENT_RESCHEDULE_NOT_ALLOWED; exactly 12 hours is fine', async () => {
    myVisit(1);
    await expectRefused(move({ now: new Date(OLD.getTime() - 12 * 3600e3 + 1) }), 'APPOINTMENT_RESCHEDULE_NOT_ALLOWED');
    const { visit } = await move({ now: new Date(OLD.getTime() - 12 * 3600e3), scheduledAt: new Date('2026-11-12T06:00:00Z') });
    expect(visit.status).toBe('PENDING');
  });

  it.each([['CANCELLED'], ['COMPLETED'], ['NO_SHOW']])('a %s visit → 409 NOT_ALLOWED', async (status) => {
    myVisit(1, { status });
    await expectRefused(move(), 'APPOINTMENT_RESCHEDULE_NOT_ALLOWED');
  });

  it('after the start time → 409 NOT_ALLOWED', async () => {
    myVisit(1);
    await expectRefused(move({ now: new Date(OLD.getTime() + 60e3) }), 'APPOINTMENT_RESCHEDULE_NOT_ALLOWED');
  });

  it('already moved twice → 422 APPOINTMENT_RESCHEDULE_LIMIT_REACHED', async () => {
    const [a] = myVisit(1, { appointmentCode: 'APT-0003' });
    row(me, new Date('2026-11-11T03:00:00Z'), { appointmentCode: 'APT-0002', isActive: false, status: 'CANCELLED', cancellationReason: 'RESCHEDULED:APT-0003' });
    row(me, new Date('2026-11-10T03:00:00Z'), { appointmentCode: 'APT-0001', isActive: false, status: 'CANCELLED', cancellationReason: 'RESCHEDULED:APT-0002' });
    await expectRefused(move({ id: a._id }), 'APPOINTMENT_RESCHEDULE_LIMIT_REACHED');
  });

  it('moved once is still allowed', async () => {
    const [a] = myVisit(1, { appointmentCode: 'APT-0003' });
    row(me, new Date('2026-11-11T03:00:00Z'), { appointmentCode: 'APT-0002', isActive: false, status: 'CANCELLED', cancellationReason: 'RESCHEDULED:APT-0003' });
    expect((await move({ id: a._id })).visit.status).toBe('PENDING');
  });

  it('the same slot → 409 APPOINTMENT_DUPLICATE', async () => {
    myVisit(1);
    await expectRefused(move({ scheduledAt: OLD }), 'APPOINTMENT_DUPLICATE');
  });

  it.each([
    ['too soon (customer lead time is 2 h)', new Date('2026-11-08T01:00:00Z'), 'APPOINTMENT_TOO_SOON'],
    ['too far', new Date('2027-02-12T03:00:00Z'), 'APPOINTMENT_TOO_FAR'],
    ['off the slot grid', new Date('2026-11-13T06:30:00Z'), 'APPOINTMENT_SLOT_INVALID'],
  ])('a new time that is %s', async (_name, scheduledAt, code) => {
    myVisit(1);
    await expectRefused(move({ scheduledAt }), code);
  });

  it("another customer's visit and an unknown id are both 404; a missing customer is CUSTOMER_NOT_FOUND", async () => {
    const theirs = row(rival, OLD);
    myVisit(1);
    await expectRefused(move({ id: theirs._id }), 'APPOINTMENT_NOT_FOUND');
    await expectRefused(move({ id: new mongoose.Types.ObjectId() }), 'APPOINTMENT_NOT_FOUND');
    await expectRefused(move({ customerId: undefined }), 'CUSTOMER_NOT_FOUND');
  });

  it('the new slot is full → 409 CAPACITY_FULL, and nothing was written', async () => {
    myVisit(1);
    row(rival, NEW); row(fakes.addCustomer(), NEW);
    await expectRefused(move(), 'APPOINTMENT_CAPACITY_FULL');
  });

  it('a car already taken at the new slot → 409 CONFLICT naming it', async () => {
    const [a] = myVisit(2);
    row(rival, NEW, { car: a.car });
    const before = snapshot();
    const error = await reject(move());
    expect(error).toMatchObject({ code: 'APPOINTMENT_CONFLICT', errors: { carIds: [String(a.car)] } });
    expect(snapshot()).toBe(before);
  });

  it('the customer already has a visit at the new slot → 409 DUPLICATE', async () => {
    myVisit(1);
    row(me, NEW);
    await expectRefused(move(), 'APPOINTMENT_DUPLICATE');
  });

  it('a car that is no longer sellable → 409 CAR_UNAVAILABLE; its appointment is cancelled and the customer told once', async () => {
    const [a, b] = myVisit(2);
    fakes.state.cars.find((c) => String(c._id) === String(b.car)).status = 'SOLD';
    const error = await reject(move({ id: a._id }));
    expect(error?.code).toBe('APPOINTMENT_CAR_UNAVAILABLE');
    expect(b).toMatchObject({ status: 'CANCELLED', cancellationReason: 'AUTO_CAR_UNAVAILABLE:SOLD' });
    expect(a).toMatchObject({ status: 'PENDING', isActive: true }); // the visit itself did not move
    const sent = await fakes.flushMail();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('có xe không còn khả dụng');
  });

  it('never deletes a row physically', async () => {
    myVisit(2);
    const before = fakes.appointments.length;
    await move();
    expect(fakes.appointments.length).toBe(before + 2);
  });
});

describe('staff reschedule (REQ-034, AC-33)', () => {
  // The scenario this feature exists for: 09:45, the 10:00 customer says they cannot come; move to 13:00.
  const TEN = new Date('2026-11-12T03:00:00Z');
  const ONE_PM = new Date('2026-11-12T06:00:00Z');
  const quarterToTen = new Date('2026-11-12T02:45:00Z');

  it('moves a CONFIRMED visit 15 minutes before it starts, to a slot a customer could not book, and keeps it CONFIRMED', async () => {
    const [a] = [row(me, TEN, { status: 'CONFIRMED', assignedTo: staffId, confirmedBy: staffId, confirmedAt: NOW })];
    const { visit, previousVisitCode } = await moveByStaff({ scheduledAt: ONE_PM, now: quarterToTen });
    expect(previousVisitCode).toBe(a.appointmentCode);
    expect(visit).toMatchObject({
      status: 'CONFIRMED', scheduledAt: ONE_PM.toISOString(),
      customer: { fullName: 'Nguyễn An' }, confirmedBy: { _id: String(staffId) },
    });
    expect(visible()[0]).toMatchObject({ status: 'CONFIRMED' });
    expect(String(visible()[0].confirmedBy)).toBe(String(staffId));
    expect(String(visible()[0].assignedTo)).toBe(String(staffId));
    expect(hidden()[0].cancellationReason).toBe(`RESCHEDULED:${visit.visitCode}`);
    expect(logSpy.mock.calls[0][0]).toMatchObject({ eventType: 'APPOINTMENT_RESCHEDULED', performedBy: staffId });
  });

  it('a customer could not do the same (lead time and 12-hour rule)', async () => {
    row(me, TEN, { status: 'CONFIRMED' });
    const error = await reject(rescheduleMyVisit({ customerId: me._id, userId, id: fakes.appointments[0]._id, scheduledAt: ONE_PM, now: quarterToTen }));
    expect(error.code).toBe('APPOINTMENT_RESCHEDULE_NOT_ALLOWED');
  });

  it('a PENDING visit stays PENDING and unassigned', async () => {
    row(me, TEN);
    const { visit } = await moveByStaff({ scheduledAt: ONE_PM, now: quarterToTen });
    expect(visit.status).toBe('PENDING');
    expect(visible()[0].confirmedBy).toBeNull();
  });

  it('also works after the old time has passed while the visit is still open (the customer called late)', async () => {
    row(me, TEN, { status: 'CONFIRMED' });
    const { visit } = await moveByStaff({ scheduledAt: ONE_PM, now: new Date('2026-11-12T03:30:00Z') });
    expect(visit.status).toBe('CONFIRMED');
  });

  it('has no limit on the number of moves', async () => {
    const [a] = [row(me, OLD, { appointmentCode: 'APT-0009' })];
    ['APT-0008:APT-0009', 'APT-0007:APT-0008', 'APT-0006:APT-0007'].forEach((pair) => {
      const [code, successor] = pair.split(':');
      row(me, new Date('2026-11-10T03:00:00Z'), { appointmentCode: code, isActive: false, status: 'CANCELLED', cancellationReason: `RESCHEDULED:${successor}` });
    });
    const { visit } = await moveByStaff({ id: a._id });
    expect(visit.status).toBe('PENDING');
  });

  it('refuses a slot that already started or is off the grid (422), a closed visit (409) and an unknown one (404)', async () => {
    row(me, OLD);
    expect((await reject(moveByStaff({ scheduledAt: new Date('2026-11-07T03:00:00Z') }))).code).toBe('APPOINTMENT_TOO_SOON');
    expect((await reject(moveByStaff({ scheduledAt: new Date('2026-11-13T06:30:00Z') }))).code).toBe('APPOINTMENT_SLOT_INVALID');
    expect((await reject(moveByStaff({ id: new mongoose.Types.ObjectId() }))).code).toBe('APPOINTMENT_NOT_FOUND');
    fakes.appointments[0].status = 'COMPLETED';
    expect((await reject(moveByStaff())).code).toBe('APPOINTMENT_RESCHEDULE_NOT_ALLOWED');
  });

  it('staff cannot overbook: a full slot or a taken car still refuses (409)', async () => {
    const [a] = [row(me, OLD)];
    row(rival, NEW); row(fakes.addCustomer(), NEW);
    expect((await reject(moveByStaff())).code).toBe('APPOINTMENT_CAPACITY_FULL');
    fakes.appointments.splice(1);
    row(rival, NEW, { car: a.car });
    expect((await reject(moveByStaff())).code).toBe('APPOINTMENT_CONFLICT');
    expect(visible().filter((r) => r.isActive && String(r.customer) === String(me._id))).toHaveLength(1);
  });
});
