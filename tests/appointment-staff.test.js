/**
 * @file appointment-staff.test.js
 * @description Staff view of visits: list/filter/paginate, read, and status changes
 * (C5 transitions, whole-visit effect, car re-check on confirm, compare-and-set, audit).
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-018…021, 023; AC-17…20)
 */

import { jest } from '@jest/globals';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { listVisits, getVisit, changeVisitStatus } from '../src/services/appointmentStaffService.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';
import { default as Appointment } from '../src/models/Appointment.js';

const fakes = await setupAppointmentFakes();
const logSpy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const SLOT = new Date('2026-11-10T03:00:00Z');
const NOW = new Date('2026-11-08T00:00:00Z');
const AFTER = new Date(SLOT.getTime() + 3600e3);
let staff;
let guest;

beforeEach(() => {
  fakes.reset(); logSpy.mockClear();
  staff = fakes.addUser({ fullName: 'Lan Sales' });
  guest = fakes.addCustomer({ fullName: 'Khách Một', phone: '0911111111' });
});

const row = (scheduledAt, extra = {}) =>
  fakes.addAppointment({ customer: guest._id, car: fakes.addCar()._id, scheduledAt, createdAt: NOW, ...extra });
const change = (extra = {}) => changeVisitStatus({
  id: fakes.appointments[0]._id, userId: staff._id, status: 'CONFIRMED', now: NOW, ...extra,
});
const reject = (promise) => promise.then(() => null, (error) => error);
const statuses = () => fakes.appointments.map((r) => r.status);

describe('list / read (AC-17)', () => {
  it('lists upcoming visits oldest first with customer contact and the car\'s current status', async () => {
    row(new Date('2026-11-11T03:00:00Z'), { car: fakes.addCar({ status: 'SOLD' })._id });
    row(SLOT);
    row(new Date('2026-11-01T03:00:00Z')); // before today: hidden by default
    const { visits } = await listVisits({ now: NOW });
    expect(visits.map((v) => v.scheduledAt)).toEqual(['2026-11-10T03:00:00.000Z', '2026-11-11T03:00:00.000Z']);
    expect(visits[0].customer).toEqual({ _id: String(guest._id), fullName: 'Khách Một', phone: '0911111111', email: 'k@example.com' });
    expect(visits[1].appointments[0].car.status).toBe('SOLD');
  });

  it('filters by status, car, date range and cancellation type', async () => {
    const pending = row(SLOT);
    row(new Date('2026-11-12T03:00:00Z'), { status: 'CANCELLED', cancellationReason: 'AUTO_CAR_UNAVAILABLE:SOLD' });
    row(new Date('2026-11-13T03:00:00Z'), { status: 'CANCELLED', cancellationReason: 'SHOWROOM_BUSY|bận', updatedBy: staff._id });
    const q = (query) => listVisits({ query, now: NOW }).then((r) => r.visits.length);
    expect(await q({ status: 'PENDING' })).toBe(1);
    expect(await q({ carId: String(pending.car) })).toBe(1);
    expect(await q({ cancellationType: 'CAR_UNAVAILABLE' })).toBe(1);
    expect(await q({ cancellationType: 'STAFF' })).toBe(1);
    expect(await q({ cancellationType: 'CUSTOMER' })).toBe(0);
    expect(await q({ from: '2026-11-12', to: '2026-11-12' })).toBe(1);
    expect(await q({ from: '2026-11-01' })).toBe(3);
  });

  it('paginates by visit and rejects bad dates with 422', async () => {
    [10, 11, 12].forEach((d) => row(new Date(`2026-11-${d}T03:00:00Z`)));
    const page = await listVisits({ query: { limit: 2, page: 2 }, now: NOW });
    expect(page.visits).toHaveLength(1);
    expect(page.pagination).toMatchObject({ total: 3, totalPages: 2 });
    expect((await reject(listVisits({ query: { from: 'bad' }, now: NOW }))).code).toBe('VALIDATION_ERROR');
    expect((await reject(listVisits({ query: { from: '2026-11-12', to: '2026-11-10' }, now: NOW }))).code).toBe('VALIDATION_ERROR');
  });

  it('reads a visit by any appointment id and 404s on an unknown one', async () => {
    const [a, b] = [row(SLOT), row(SLOT)];
    expect((await getVisit({ id: b._id })).visitId).toBe(String(a._id));
    expect((await reject(getVisit({ id: new Appointment()._id }))).code).toBe('APPOINTMENT_NOT_FOUND');
  });
});

// ── 1.1.0: reminder flags, filters, reschedule count (REQ-037; AC-35) ──────────
describe('reminder flags and filters', () => {
  const quarterToTen = new Date(SLOT.getTime() - 15 * 60e3);
  const nine = new Date(SLOT.getTime() - 60 * 60e3);

  it('marks a CONFIRMED visit starting within 30 minutes as needing a reminder call, and filters on it', async () => {
    row(SLOT, { status: 'CONFIRMED' });
    row(new Date('2026-11-10T06:00:00Z'), { status: 'CONFIRMED' }); // 13:00: far away
    row(SLOT, { status: 'PENDING', customer: fakes.addCustomer()._id }); // not confirmed yet
    const all = await listVisits({ now: quarterToTen });
    // 1.2.0 (REQ-042): the PENDING visit is pinned to the top, then the rest by time.
    expect(all.visits.map((v) => v.status)).toEqual(['PENDING', 'CONFIRMED', 'CONFIRMED']);
    expect(all.visits.map((v) => v.needsReminderCall)).toEqual([false, true, false]);
    const only = await listVisits({ query: { needsReminderCall: true }, now: quarterToTen });
    expect(only.visits).toHaveLength(1);
    expect(only.visits[0]).toMatchObject({ status: 'CONFIRMED', needsReminderCall: true, needsOutcome: false });
    expect((await listVisits({ query: { needsReminderCall: true }, now: nine })).visits).toHaveLength(0);
  });

  it('marks a visit that is still open after its time as needing an outcome, and never changes its status', async () => {
    row(SLOT, { status: 'CONFIRMED' });
    const late = new Date(SLOT.getTime() + 2 * 3600e3);
    const { visits } = await listVisits({ now: late, query: { from: '2026-11-01' } });
    expect(visits[0]).toMatchObject({ needsOutcome: true, needsReminderCall: false, status: 'CONFIRMED' });
    expect(statuses()).toEqual(['CONFIRMED']);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('looks back 7 days for needsOutcome when no `from` is given, otherwise only from today', async () => {
    const sixDaysAgo = new Date(NOW.getTime() - 6 * 86400e3);
    const eightDaysAgo = new Date(NOW.getTime() - 8 * 86400e3);
    row(sixDaysAgo, { status: 'CONFIRMED' }); row(eightDaysAgo, { status: 'CONFIRMED' }); row(SLOT);
    expect((await listVisits({ query: { needsOutcome: true }, now: NOW })).visits).toHaveLength(1);
    expect((await listVisits({ now: NOW })).visits).toHaveLength(1); // default: today onwards
    expect((await listVisits({ query: { needsOutcome: true, from: '2026-10-01' }, now: NOW })).visits).toHaveLength(2);
  });

  it('accepts the boolean the route validator produces and the string a direct caller might pass', async () => {
    row(SLOT, { status: 'CONFIRMED' });
    expect((await listVisits({ query: { needsReminderCall: 'true' }, now: quarterToTen })).visits).toHaveLength(1);
    expect((await listVisits({ query: { needsReminderCall: false }, now: quarterToTen })).visits).toHaveLength(1);
  });

  it('shows how often a visit was moved, one lookup for the whole page', async () => {
    row(SLOT, { appointmentCode: 'APT-0030' });
    row(new Date('2026-11-12T03:00:00Z'), { appointmentCode: 'APT-0040' });
    fakes.addAppointment({ customer: guest._id, car: fakes.addCar()._id, scheduledAt: new Date('2026-11-09T03:00:00Z'), appointmentCode: 'APT-0029', isActive: false, status: 'CANCELLED', cancellationReason: 'RESCHEDULED:APT-0030' });
    const before = fakes.count('Appointment', 'find');
    const { visits } = await listVisits({ now: NOW });
    expect(visits.map((v) => [v.visitCode, v.rescheduleCount])).toEqual([['APT-0030', 1], ['APT-0040', 0]]);
    expect(fakes.count('Appointment', 'find') - before).toBeLessThanOrEqual(1 + 1 + 3); // reconcile + list + chain (≤ 3)
  });
});

describe('status changes (REQ-019, AC-18)', () => {
  it('confirms every open appointment of the visit and records who did it', async () => {
    row(SLOT); row(SLOT); row(SLOT, { status: 'CANCELLED', cancellationReason: 'AUTO_CAR_UNAVAILABLE:SOLD' });
    const visit = await change();
    expect(statuses()).toEqual(['CONFIRMED', 'CONFIRMED', 'CANCELLED']);
    fakes.appointments.slice(0, 2).forEach((r) => {
      expect(String(r.confirmedBy)).toBe(String(staff._id));
      expect(r.confirmedAt).toEqual(NOW);
      expect(String(r.assignedTo)).toBe(String(staff._id));
    });
    expect(visit).toMatchObject({ status: 'CONFIRMED', confirmedBy: { fullName: 'Lan Sales' }, assignedTo: { fullName: 'Lan Sales' } });
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0][0]).toMatchObject({ eventType: 'APPOINTMENT_CONFIRMED', changes: { before: { status: 'PENDING' } } });
  });

  it('keeps an already assigned staff member', async () => {
    const other = fakes.addUser();
    row(SLOT, { assignedTo: other._id });
    await change();
    expect(String(fakes.appointments[0].assignedTo)).toBe(String(other._id));
  });

  it('completes after the visit time with an outcome, or marks a no-show', async () => {
    row(SLOT, { status: 'CONFIRMED' });
    const done = await change({ status: 'COMPLETED', outcome: ' hài lòng ', now: AFTER });
    expect(done).toMatchObject({ status: 'COMPLETED', outcome: 'hài lòng', completedAt: AFTER.toISOString() });
    expect(logSpy.mock.calls[0][0].eventType).toBe('APPOINTMENT_COMPLETED');

    fakes.reset(); logSpy.mockClear();
    row(SLOT, { status: 'CONFIRMED' });
    await change({ status: 'NO_SHOW', now: AFTER });
    expect(statuses()).toEqual(['NO_SHOW']);
    expect(logSpy.mock.calls[0][0].eventType).toBe('APPOINTMENT_NO_SHOW');
  });

  // 1.1.0 (REQ-030, C20): a chosen reason code + an internal note; without a code it is OTHER.
  it('cancels with a chosen reason: the label is the reason, the note stays internal', async () => {
    row(SLOT);
    const visit = await change({ status: 'CANCELLED', reasonCode: 'SHOWROOM_BUSY', reason: ' Xe đang bảo dưỡng ' });
    expect(visit).toMatchObject({
      status: 'CANCELLED', cancellationType: 'STAFF',
      cancellationReason: 'Showroom có việc đột xuất', cancellationNote: 'Xe đang bảo dưỡng',
    });
    expect(fakes.appointments[0].cancellationReason).toBe('SHOWROOM_BUSY|Xe đang bảo dưỡng');
  });

  it('a 1.0.0 client (reason only) is treated as OTHER and the note is mandatory', async () => {
    row(SLOT);
    const visit = await change({ status: 'CANCELLED', reason: 'Xe đang bảo dưỡng' });
    expect(visit).toMatchObject({ cancellationType: 'STAFF', cancellationReason: 'Showroom đã hủy lịch hẹn của bạn', cancellationNote: 'Xe đang bảo dưỡng' });
  });

  it('a note without a reason code never forges a system cancellation', async () => {
    row(SLOT);
    const visit = await change({ status: 'CANCELLED', reasonCode: 'CUSTOMER_CHANGED_MIND', reason: 'AUTO_CAR_UNAVAILABLE:SOLD' });
    expect(visit).toMatchObject({ cancellationType: 'STAFF', cancellationReason: 'Bạn đã thay đổi ý định' });
  });
});

describe('invalid changes leave data untouched (REQ-020, REQ-021, AC-19, AC-20)', () => {
  it.each([
    ['PENDING → COMPLETED', 'PENDING', 'COMPLETED', AFTER],
    ['COMPLETED → CONFIRMED', 'COMPLETED', 'CONFIRMED', AFTER],
    ['CANCELLED → CONFIRMED', 'CANCELLED', 'CONFIRMED', NOW],
    ['CONFIRMED → COMPLETED before the visit', 'CONFIRMED', 'COMPLETED', NOW],
    ['CONFIRMED → NO_SHOW before the visit', 'CONFIRMED', 'NO_SHOW', NOW],
  ])('%s → 409 APPOINTMENT_STATUS_INVALID', async (_n, from, to, now) => {
    row(SLOT, { status: from });
    expect(await reject(change({ status: to, now }))).toMatchObject({ statusCode: 409, code: 'APPOINTMENT_STATUS_INVALID' });
    expect(statuses()).toEqual([from]);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('cancelling needs a reason; OTHER needs a note; unknown code, over-long note, code on a non-cancel → 422 (AC-29)', async () => {
    row(SLOT);
    const bad = [
      { status: 'CANCELLED' },
      { status: 'CANCELLED', reason: '   ' },
      { status: 'CANCELLED', reasonCode: 'OTHER' },
      { status: 'CANCELLED', reasonCode: 'NOPE', reason: 'x' },
      { status: 'CANCELLED', reasonCode: 'SHOWROOM_BUSY', reason: 'x'.repeat(301) },
      { status: 'CONFIRMED', reasonCode: 'SHOWROOM_BUSY' },
    ];
    for (const extra of bad) {
      expect((await reject(change(extra))).code).toBe('VALIDATION_ERROR');
    }
    expect(statuses()).toEqual(['PENDING']);
  });

  // 1.1.0 (REQ-021): before refusing, the appointment of the unsellable car is cancelled
  // (reconciliation); the visit itself is not confirmed and the other car keeps its status.
  it('refuses to confirm when a car is no longer sellable (409 APPOINTMENT_CAR_UNAVAILABLE)', async () => {
    row(SLOT); row(SLOT, { car: fakes.addCar({ status: 'RESERVED' })._id });
    expect(await reject(change())).toMatchObject({ statusCode: 409, code: 'APPOINTMENT_CAR_UNAVAILABLE' });
    expect(statuses()).toEqual(['PENDING', 'CANCELLED']);
    expect(fakes.appointments[1].cancellationReason).toBe('AUTO_CAR_UNAVAILABLE:RESERVED');
  });

  it('reports a conflict when somebody else changed the visit first (compare-and-set)', async () => {
    row(SLOT);
    Appointment.updateMany.mockImplementationOnce(async () => ({ modifiedCount: 0 }));
    expect((await reject(change())).code).toBe('APPOINTMENT_STATUS_INVALID');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('404 for an unknown visit; nothing is ever deleted physically', async () => {
    row(SLOT);
    expect((await reject(change({ id: new Appointment()._id }))).code).toBe('APPOINTMENT_NOT_FOUND');
    await change({ status: 'CANCELLED', reason: 'x' });
    expect(fakes.appointments).toHaveLength(1);
  });
});
