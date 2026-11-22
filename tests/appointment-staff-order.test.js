/**
 * @file appointment-staff-order.test.js
 * @description Order of the staff list (1.2.0): visits that need attention are pinned to the top,
 * the rest follow the visit time (`sort=asc|desc`); `isNewRequest` is computed per call.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-042…044, C30; AC-40…42)
 */

import { jest } from '@jest/globals';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { groupIntoVisits } from '../src/services/appointmentVisitRules.js';
import { isNewRequest, orderForStaff } from '../src/services/appointmentStaffOrder.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';

const fakes = await setupAppointmentFakes();
jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const NOW = new Date('2026-11-11T05:00:00Z'); // 12:00 VN on 11 Nov
const at = (iso) => new Date(iso);
const TODAY_09 = at('2026-11-11T02:00:00Z');
const TODAY_10 = at('2026-11-11T03:00:00Z');
const TODAY_11 = at('2026-11-11T04:00:00Z');
const YESTERDAY = at('2026-11-10T08:00:00Z'); // 15:00 VN on 10 Nov
const THREE_DAYS_AGO = at('2026-11-08T08:00:00Z');
let n;

beforeEach(() => {
  fakes.reset();
  n = 0;
});

/** One visit = one customer, one car, one time. `createdAt` is when the customer sent it. */
const visit = (scheduledAt, extra = {}) => {
  n += 1;
  return fakes.addAppointment({
    customer: fakes.addCustomer({ fullName: `Khách ${n}`, phone: `09000000${n}` })._id,
    car: fakes.addCar()._id,
    scheduledAt: at(scheduledAt),
    status: 'PENDING',
    createdAt: NOW,
    ...extra,
  });
};
const grouped = () => groupIntoVisits(fakes.appointments);
const codes = (result) => result.visits.map((v) => v.visitCode);

describe('isNewRequest (REQ-044, C30)', () => {
  it('every PENDING visit is pinned, whatever day it was sent', () => {
    visit('2026-11-20T03:00:00Z', { createdAt: TODAY_10 });
    visit('2026-11-20T06:00:00Z', { createdAt: THREE_DAYS_AGO });
    expect(grouped().map((v) => isNewRequest(v, NOW))).toEqual([true, true]);
  });

  it('a CONFIRMED visit confirmed at the instant it was created (staff moved it or booked it) is pinned for the day', () => {
    visit('2026-11-20T03:00:00Z', { status: 'CONFIRMED', createdAt: TODAY_10, confirmedAt: TODAY_10 });
    visit('2026-11-20T06:00:00Z', { status: 'CONFIRMED', createdAt: TODAY_10, confirmedAt: new Date(TODAY_10.getTime() + 4000) });
    expect(grouped().map((v) => isNewRequest(v, NOW))).toEqual([true, true]);
  });

  it('a CONFIRMED visit the customer sent and staff confirmed later is NOT pinned', () => {
    visit('2026-11-20T03:00:00Z', { status: 'CONFIRMED', createdAt: TODAY_09, confirmedAt: TODAY_11 });
    expect(isNewRequest(grouped()[0], NOW)).toBe(false);
  });

  it('the day-long pin of a staff-made CONFIRMED visit ends with the Vietnam day', () => {
    visit('2026-11-20T03:00:00Z', { status: 'CONFIRMED', createdAt: YESTERDAY, confirmedAt: YESTERDAY });
    const [v] = grouped();
    expect(isNewRequest(v, NOW)).toBe(false);
    expect(isNewRequest(groupIntoVisits([{ ...v.rows[0], createdAt: TODAY_09, confirmedAt: TODAY_09 }])[0], NOW)).toBe(true);
    // 16:59 VN today still pinned; 00:00 VN tomorrow released (17:00Z is the day boundary).
    const lastMinute = at('2026-11-11T16:59:00Z');
    const nextDay = at('2026-11-11T17:00:00Z');
    const fresh = groupIntoVisits([{ ...v.rows[0], createdAt: TODAY_09, confirmedAt: TODAY_09 }])[0];
    expect(isNewRequest(fresh, lastMinute)).toBe(true);
    expect(isNewRequest(fresh, nextDay)).toBe(false);
  });

  it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW'])('a %s visit is never pinned', (status) => {
    visit('2026-11-20T03:00:00Z', { status, createdAt: TODAY_10, confirmedAt: TODAY_10 });
    expect(isNewRequest(grouped()[0], NOW)).toBe(false);
  });

  it('a PENDING visit stays pinned the next day (until staff confirm or cancel it)', () => {
    visit('2026-11-20T03:00:00Z', { createdAt: TODAY_10 });
    expect(isNewRequest(grouped()[0], at('2026-11-14T03:00:00Z'))).toBe(true);
  });
});

describe('orderForStaff (REQ-042, REQ-043; AC-40, AC-41)', () => {
  const seed = () => {
    visit('2026-11-14T03:00:00Z', { createdAt: TODAY_09 }); // pending, sent 09:00
    visit('2026-11-15T03:00:00Z', { createdAt: TODAY_11 }); // pending, sent 11:00
    visit('2026-11-12T03:00:00Z', { createdAt: TODAY_10 }); // pending, sent 10:00
    visit('2026-11-13T03:00:00Z', { createdAt: YESTERDAY }); // pending, sent yesterday
    visit('2026-11-18T03:00:00Z', { status: 'CONFIRMED', createdAt: TODAY_09, confirmedAt: TODAY_11 });
    visit('2026-11-16T03:00:00Z', { status: 'CONFIRMED', createdAt: TODAY_09, confirmedAt: TODAY_11 });
  };
  const label = (visits) => visits.map((v) => v.scheduledAt.toISOString().slice(5, 10));

  it('pins every PENDING visit, newest booking first, then the rest by visit time ascending', () => {
    seed();
    const ordered = orderForStaff(grouped(), { now: NOW });
    // pending by booking time desc: 11:00 (15 Nov), 10:00 (12 Nov), 09:00 (14 Nov), yesterday (13 Nov); then confirmed 16, 18.
    expect(label(ordered)).toEqual(['11-15', '11-12', '11-14', '11-13', '11-16', '11-18']);
  });

  it('sort=desc flips only the part that is not pinned', () => {
    seed();
    const ordered = orderForStaff(grouped(), { sort: 'desc', now: NOW });
    expect(label(ordered)).toEqual(['11-15', '11-12', '11-14', '11-13', '11-18', '11-16']);
  });

  it('is stable between calls and does not modify its input', () => {
    seed();
    const input = grouped();
    const copy = [...input];
    const once = orderForStaff(input, { now: NOW }).map((v) => v.visitId);
    const twice = orderForStaff(input, { now: NOW }).map((v) => v.visitId);
    expect(once).toEqual(twice);
    expect(input).toEqual(copy);
  });

  it('visits with the same time keep a fixed order (by id)', () => {
    visit('2026-11-14T03:00:00Z', { status: 'CONFIRMED', createdAt: TODAY_09, confirmedAt: TODAY_11 });
    visit('2026-11-14T03:00:00Z', { status: 'CONFIRMED', createdAt: TODAY_09, confirmedAt: TODAY_11 });
    const a = orderForStaff(grouped(), { now: NOW }).map((v) => v.visitId);
    const b = orderForStaff([...grouped()].reverse(), { now: NOW }).map((v) => v.visitId);
    expect(a).toEqual(b);
  });

  it('an empty list is fine', () => {
    expect(orderForStaff([], { now: NOW })).toEqual([]);
  });
});
