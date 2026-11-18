/**
 * @file appointment-customer.test.js
 * @description Customer-side visits: list (own only, grouped, paged), read, cancel
 * (late flag, errors, ownership, audit).
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-014…017, 023, 024; AC-14, 15, 16, 24)
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { listMyVisits, getMyVisit, cancelMyVisit } from '../src/services/appointmentCustomerService.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';

const fakes = await setupAppointmentFakes();
const logSpy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const SLOT = new Date('2026-11-10T03:00:00Z'); // 10:00 VN
const NOW = new Date('2026-11-08T00:00:00Z');
const userId = new mongoose.Types.ObjectId();
let me;
let rival;

beforeEach(() => {
  fakes.reset(); logSpy.mockClear();
  me = fakes.addCustomer(); rival = fakes.addCustomer();
});

const row = (who, scheduledAt, extra = {}) =>
  fakes.addAppointment({ customer: who._id, car: fakes.addCar()._id, scheduledAt, createdBy: userId, createdAt: NOW, ...extra });
const visitOf = (n, extra = {}) => Array.from({ length: n }, () => row(me, SLOT, extra));
const reject = (promise) => promise.then(() => null, (error) => error);
const cancel = (extra = {}) => cancelMyVisit({
  customerId: me._id, userId, id: fakes.appointments[0]._id, now: NOW, ...extra,
});

describe('list / read (AC-14)', () => {
  it('shows only my visits, grouped by slot, newest first', async () => {
    visitOf(2);
    row(me, new Date('2026-11-12T03:00:00Z'));
    row(rival, SLOT);
    const { visits, pagination } = await listMyVisits({ customerId: me._id });
    expect(visits.map((v) => v.appointments.length)).toEqual([1, 2]);
    expect(visits[0].scheduledAt).toBe('2026-11-12T03:00:00.000Z');
    expect(pagination).toMatchObject({ total: 2, page: 1, limit: 10, totalPages: 1 });
  });

  it('filters by derived status and pages by visit', async () => {
    visitOf(1);
    row(me, new Date('2026-11-11T03:00:00Z'), { status: 'CANCELLED' });
    row(me, new Date('2026-11-12T03:00:00Z'));
    expect((await listMyVisits({ customerId: me._id, query: { status: 'CANCELLED' } })).visits).toHaveLength(1);
    const page2 = await listMyVisits({ customerId: me._id, query: { limit: 2, page: 2 } });
    expect(page2.visits).toHaveLength(1);
    expect(page2.pagination).toMatchObject({ total: 3, totalPages: 2, limit: 2 });
  });

  it('caps the page size at 50 and hides inactive rows', async () => {
    visitOf(1);
    row(me, new Date('2026-11-11T03:00:00Z'), { isActive: false });
    const result = await listMyVisits({ customerId: me._id, query: { limit: 500 } });
    expect(result.pagination.limit).toBe(50);
    expect(result.visits).toHaveLength(1);
  });

  it('reads my visit by the id of any of its appointments', async () => {
    const rows = visitOf(2);
    const visit = await getMyVisit({ customerId: me._id, id: rows[1]._id });
    expect(visit.appointments).toHaveLength(2);
  });

  it('answers 404 APPOINTMENT_NOT_FOUND identically for another customer\'s visit and a missing id', async () => {
    const theirs = row(rival, SLOT);
    const a = await reject(getMyVisit({ customerId: me._id, id: theirs._id }));
    const b = await reject(getMyVisit({ customerId: me._id, id: new mongoose.Types.ObjectId() }));
    expect(a).toMatchObject({ statusCode: 404, code: 'APPOINTMENT_NOT_FOUND' });
    expect(b.message).toBe(a.message);
  });

  it('needs a linked customer', async () => {
    expect((await reject(listMyVisits({ customerId: null }))).code).toBe('CUSTOMER_NOT_FOUND');
  });
});

describe('cancel (REQ-016, AC-15)', () => {
  it('cancels every open appointment, keeps the reason, not late with 24 h to go', async () => {
    visitOf(2);
    fakes.now = () => new Date(SLOT.getTime() - 24 * 3600e3);
    const visit = await cancel({ reason: '  đổi lịch công ty ' });
    expect(visit).toMatchObject({ status: 'CANCELLED', cancellationType: 'CUSTOMER', cancellationReason: 'đổi lịch công ty', isLateCancellation: false });
    expect(fakes.appointments.every((r) => r.status === 'CANCELLED' && String(r.updatedBy) === String(userId))).toBe(true);
    expect(logSpy).toHaveBeenCalledTimes(2);
    logSpy.mock.calls.forEach(([e]) => expect(e).toMatchObject({
      eventType: 'APPOINTMENT_CANCELLED', changes: { before: { status: 'PENDING' }, after: { status: 'CANCELLED' } },
    }));
  });

  it('flags a late cancellation (< 12 h before the visit)', async () => {
    visitOf(1);
    fakes.now = () => new Date(SLOT.getTime() - 7 * 3600e3);
    expect((await cancel()).isLateCancellation).toBe(true);
  });

  it('does not flag it when cancelled within 30 minutes of booking', async () => {
    const booked = new Date(SLOT.getTime() - 3 * 3600e3);
    row(me, SLOT, { createdAt: booked });
    fakes.now = () => new Date(booked.getTime() + 20 * 60e3);
    expect((await cancel({ now: fakes.state.now() })).isLateCancellation).toBe(false);
  });

  it('leaves auto-cancelled siblings untouched', async () => {
    row(me, SLOT);
    row(me, SLOT, { status: 'CANCELLED', cancellationReason: 'AUTO_CAR_UNAVAILABLE:SOLD' });
    const visit = await cancel();
    expect(visit.status).toBe('CANCELLED');
    expect(fakes.appointments[1].cancellationReason).toBe('AUTO_CAR_UNAVAILABLE:SOLD');
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a forged system reason and an over-long one with 422, changing nothing', async () => {
    visitOf(1);
    expect((await reject(cancel({ reason: 'AUTO_CAR_UNAVAILABLE:SOLD' }))).code).toBe('VALIDATION_ERROR');
    expect((await reject(cancel({ reason: 'x'.repeat(501) }))).code).toBe('VALIDATION_ERROR');
    expect(fakes.appointments[0].status).toBe('PENDING');
  });

  // 1.1.0 (C22): a customer must not be able to pass off their cancellation as a staff / system one.
  it.each(['SHOWROOM_BUSY|x', 'OTHER|', 'CUSTOMER_WILL_NOT_COME|gọi', 'RESCHEDULED:APT-0001', 'RACE_LOST', 'BOOKING_ABORTED'])(
    'refuses the forged reason %j with 422', async (text) => {
      visitOf(1);
      expect((await reject(cancel({ reason: text }))).code).toBe('VALIDATION_ERROR');
      expect(fakes.appointments[0].status).toBe('PENDING');
    },
  );

  it('still succeeds when the audit log fails afterwards', async () => {
    visitOf(1);
    logSpy.mockRejectedValueOnce(new Error('log down'));
    await expect(cancel()).resolves.toMatchObject({ status: 'CANCELLED' });
  });
});

// ── 1.1.0: rescheduleCount / canReschedule (REQ-024, REQ-031) ─────────────────
describe('reschedule information on every visit', () => {
  const early = new Date(SLOT.getTime() - 3 * 86400e3);

  it('canReschedule is true with 12 h or more to go and fewer than 2 earlier moves', async () => {
    visitOf(1);
    const { visits } = await listMyVisits({ customerId: me._id, now: early });
    expect(visits[0]).toMatchObject({ rescheduleCount: 0, canReschedule: true });
  });

  it('false with under 12 h to go, after the start, or for a closed visit', async () => {
    const [a] = visitOf(1);
    expect((await getMyVisit({ customerId: me._id, id: a._id, now: new Date(SLOT.getTime() - 11 * 3600e3) })).canReschedule).toBe(false);
    expect((await getMyVisit({ customerId: me._id, id: a._id, now: new Date(SLOT.getTime() + 60e3) })).canReschedule).toBe(false);
    a.status = 'CANCELLED';
    expect((await getMyVisit({ customerId: me._id, id: a._id, now: early })).canReschedule).toBe(false);
  });

  it('counts the earlier moves, and is false once the limit (2) is reached', async () => {
    const [a] = [row(me, SLOT, { appointmentCode: 'APT-0003' })];
    row(me, new Date('2026-11-09T03:00:00Z'), { appointmentCode: 'APT-0002', isActive: false, status: 'CANCELLED', cancellationReason: 'RESCHEDULED:APT-0003' });
    expect(await getMyVisit({ customerId: me._id, id: a._id, now: early })).toMatchObject({ rescheduleCount: 1, canReschedule: true });
    row(me, new Date('2026-11-08T03:00:00Z'), { appointmentCode: 'APT-0001', isActive: false, status: 'CANCELLED', cancellationReason: 'RESCHEDULED:APT-0002' });
    expect(await getMyVisit({ customerId: me._id, id: a._id, now: early })).toMatchObject({ rescheduleCount: 2, canReschedule: false });
  });

  it('a whole page costs at most 3 extra lookups, not one per visit (NFR-09)', async () => {
    [10, 11, 12, 13, 14].forEach((d) => row(me, new Date(`2026-11-${d}T03:00:00Z`)));
    const before = fakes.count('Appointment', 'find');
    await listMyVisits({ customerId: me._id, now: early });
    expect(fakes.count('Appointment', 'find') - before).toBeLessThanOrEqual(1 + 3);
  });

  it("the cancel answer carries the same two fields (a cancelled visit can't be moved)", async () => {
    visitOf(1);
    expect(await cancel()).toMatchObject({ status: 'CANCELLED', rescheduleCount: 0, canReschedule: false });
  });

  it("the customer's own words are never mixed up with staff values", async () => {
    visitOf(1);
    const visit = await cancel({ reason: 'tôi bận' });
    expect(visit).toMatchObject({ cancellationType: 'CUSTOMER', cancellationReason: 'tôi bận' });
  });
});

describe('cancel errors (REQ-017, AC-16, AC-24)', () => {
  it('409 APPOINTMENT_CANCELLED_ALREADY when cancelled before', async () => {
    visitOf(1, { status: 'CANCELLED' });
    expect(await reject(cancel())).toMatchObject({ statusCode: 409, code: 'APPOINTMENT_CANCELLED_ALREADY' });
  });

  it.each(['COMPLETED', 'NO_SHOW'])('409 APPOINTMENT_STATUS_INVALID for a %s visit', async (status) => {
    visitOf(1, { status });
    expect(await reject(cancel())).toMatchObject({ statusCode: 409, code: 'APPOINTMENT_STATUS_INVALID' });
  });

  it('409 APPOINTMENT_STATUS_INVALID once the visit time has passed', async () => {
    visitOf(1);
    expect(await reject(cancel({ now: new Date(SLOT.getTime() + 1) }))).toMatchObject({ code: 'APPOINTMENT_STATUS_INVALID' });
    expect(fakes.appointments[0].status).toBe('PENDING');
  });

  it('404 and no change when the visit belongs to someone else', async () => {
    const theirs = row(rival, SLOT);
    expect((await reject(cancel({ id: theirs._id }))).code).toBe('APPOINTMENT_NOT_FOUND');
    expect(theirs.status).toBe('PENDING');
  });

  it('reports the status error when somebody else changed the visit first (compare-and-set)', async () => {
    const rows = visitOf(1);
    const { default: Appointment } = await import('../src/models/Appointment.js');
    // Staff completes the visit between our read and our write: the guarded update matches nothing.
    Appointment.updateMany.mockImplementationOnce(async () => {
      rows[0].status = 'COMPLETED';
      return { modifiedCount: 0 };
    });
    expect((await reject(cancel())).code).toBe('APPOINTMENT_STATUS_INVALID');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('never deletes a row physically', async () => {
    visitOf(2);
    await cancel();
    expect(fakes.appointments).toHaveLength(2);
  });
});
