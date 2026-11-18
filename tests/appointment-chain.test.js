/**
 * @file appointment-chain.test.js
 * @description Counting how many times a visit was rescheduled from the hidden rows left
 * behind (`RESCHEDULED:<code>`), for a whole page of visits at once.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (C17, REQ-032, NFR-09; AC-31, AC-39)
 */

import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { countReschedules } from '../src/services/appointmentRescheduleChain.js';
import { groupIntoVisits } from '../src/services/appointmentVisitRules.js';

const fakes = await setupAppointmentFakes();
beforeEach(() => fakes.reset());

const T = (day) => new Date(`2026-11-${day}T03:00:00Z`);
let car;
let anna;
let ben;
beforeEach(() => { car = fakes.addCar(); anna = fakes.addCustomer(); ben = fakes.addCustomer(); });

/** A visible (current) visit row. */
const current = (who, code, day) => fakes.addAppointment({ customer: who._id, car: car._id, scheduledAt: T(day), appointmentCode: code });
/** A hidden row left by a reschedule: it pointed at the visit `successor`. */
const left = (who, code, day, successor, extra = {}) => fakes.addAppointment({
  customer: who._id, car: car._id, scheduledAt: T(day), appointmentCode: code,
  isActive: false, status: 'CANCELLED', cancellationReason: `RESCHEDULED:${successor}`, ...extra,
});
const visitsOf = () => groupIntoVisits(fakes.appointments.filter((row) => row.isActive));
const count = async () => [...(await countReschedules(visitsOf())).values()];
const reads = () => fakes.count('Appointment', 'find');

describe('countReschedules', () => {
  it('is 0 for a visit that never moved, with a single query', async () => {
    current(anna, 'APT-0010', 12);
    const before = reads();
    expect(await count()).toEqual([0]);
    expect(reads() - before).toBe(1);
  });

  it('counts the chain: 1, then 2 earlier moves', async () => {
    current(anna, 'APT-0003', 12);
    left(anna, 'APT-0002', 11, 'APT-0003');
    expect(await count()).toEqual([1]);
    left(anna, 'APT-0001', 10, 'APT-0002');
    expect(await count()).toEqual([2]);
  });

  it('is capped at MAX + 1 (3) and uses at most 3 queries however long the chain is', async () => {
    current(anna, 'APT-0006', 15);
    ['APT-0005', 'APT-0004', 'APT-0003', 'APT-0002', 'APT-0001'].forEach((code, i, all) => {
      left(anna, code, 14 - i, i === 0 ? 'APT-0006' : all[i - 1]);
    });
    const before = reads();
    expect(await count()).toEqual([3]);
    expect(reads() - before).toBe(3);
  });

  it('counts every row of the previous visit, not only the first one (a visit with 2 cars)', async () => {
    current(anna, 'APT-0020', 12);
    left(anna, 'APT-0018', 11, 'APT-0020');
    left(anna, 'APT-0019', 11, 'APT-0020');
    expect(await count()).toEqual([1]);
  });

  it('ignores other customers, other hidden reasons and visible rows', async () => {
    current(anna, 'APT-0003', 12);
    left(ben, 'APT-0002', 11, 'APT-0003'); // another customer with the same code in the reason
    left(anna, 'APT-0004', 11, 'APT-0003', { cancellationReason: 'RACE_LOST' });
    left(anna, 'APT-0005', 11, 'APT-0003', { cancellationReason: 'BOOKING_ABORTED' });
    left(anna, 'APT-0006', 11, 'APT-0003', { isActive: true }); // still visible: a normal cancelled row, not a leftover
    const visits = visitsOf();
    const counts = await countReschedules(visits);
    const target = visits.find((visit) => visit.rows.some((row) => row.appointmentCode === 'APT-0003'));
    expect(counts.get(target.visitId)).toBe(0);
  });

  it('answers a whole page in the same few queries, keyed by visit', async () => {
    current(anna, 'APT-0003', 12); left(anna, 'APT-0002', 11, 'APT-0003');
    current(ben, 'APT-0013', 13);
    current(anna, 'APT-0023', 14); left(anna, 'APT-0022', 11, 'APT-0023'); left(anna, 'APT-0021', 10, 'APT-0022');
    const visits = visitsOf();
    const before = reads();
    const counts = await countReschedules(visits);
    expect(reads() - before).toBeLessThanOrEqual(3);
    const byCode = Object.fromEntries(visits.map((v) => [v.rows[0].appointmentCode, counts.get(v.visitId)]));
    expect(byCode).toEqual({ 'APT-0003': 1, 'APT-0013': 0, 'APT-0023': 2 });
  });

  it('never over-counts when the chain is broken (an earlier visit lost its key row)', async () => {
    current(anna, 'APT-0003', 12);
    left(anna, 'APT-0002', 11, 'APT-0003');
    left(anna, 'APT-0001', 10, 'APT-9999'); // points at a code that is not APT-0002
    expect(await count()).toEqual([1]);
  });

  it('an empty page needs no query', async () => {
    const before = reads();
    expect((await countReschedules([])).size).toBe(0);
    expect(reads() - before).toBe(0);
  });
});
