/**
 * @file appointment-staff-order-list.test.js
 * @description The staff list endpoint with the 1.2.0 order: pinned visits first, pagination after ordering,
 * filters, `sort`, release after confirm/cancel, and `sort` validation.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-042…044, C30; AC-40…42)
 */

import { jest } from '@jest/globals';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { listVisits, getVisit, changeVisitStatus } from '../src/services/appointmentStaffService.js';
import { staffListQuery } from '../src/routes/appointmentSchemas.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';

const fakes = await setupAppointmentFakes();
jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const NOW = new Date('2026-11-11T05:00:00Z'); // 12:00 VN on 11 Nov
const at = (iso) => new Date(iso);
const TODAY_09 = at('2026-11-11T02:00:00Z');
const TODAY_11 = at('2026-11-11T04:00:00Z');
let staff;
let n;

beforeEach(() => {
  fakes.reset();
  staff = fakes.addUser({ fullName: 'Lan Sales' });
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

describe('GET /appointments through listVisits', () => {
  const seed = () => {
    visit('2026-11-14T03:00:00Z', { createdAt: TODAY_09 });
    visit('2026-11-15T03:00:00Z', { createdAt: TODAY_11 });
    visit('2026-11-12T03:00:00Z', { status: 'CONFIRMED', createdAt: TODAY_09, confirmedAt: TODAY_11 });
    visit('2026-11-16T03:00:00Z', { status: 'CONFIRMED', createdAt: TODAY_09, confirmedAt: TODAY_11 });
  };
  const list = (query = {}) => listVisits({ query, now: NOW });

  it('returns the pinned visits first with isNewRequest, the others after with false', async () => {
    seed();
    const { visits } = await list();
    expect(visits.map((v) => v.isNewRequest)).toEqual([true, true, false, false]);
    expect(visits.map((v) => v.scheduledAt.slice(5, 10))).toEqual(['11-15', '11-14', '11-12', '11-16']);
  });

  it('paginates after ordering: the pinned visits fill page 1, the total does not change', async () => {
    seed();
    const first = await list({ page: 1, limit: 2 });
    const second = await list({ page: 2, limit: 2 });
    expect(first.visits.map((v) => v.isNewRequest)).toEqual([true, true]);
    expect(second.visits.map((v) => v.isNewRequest)).toEqual([false, false]);
    expect(first.pagination.total).toBe(4);
    expect(second.pagination.total).toBe(4);
  });

  it('a pinned visit that the filters exclude does not appear and does not push others', async () => {
    seed();
    const { visits } = await list({ status: 'CONFIRMED' });
    expect(visits.map((v) => v.scheduledAt.slice(5, 10))).toEqual(['11-12', '11-16']);
    expect(visits.every((v) => v.isNewRequest === false)).toBe(true);
  });

  it('sort=desc reverses the unpinned part only', async () => {
    seed();
    const { visits } = await list({ sort: 'desc' });
    expect(visits.map((v) => v.scheduledAt.slice(5, 10))).toEqual(['11-15', '11-14', '11-16', '11-12']);
  });

  it('confirming a pinned visit sends it back to its place by visit time', async () => {
    seed();
    const newest = (await list()).visits[0];
    await changeVisitStatus({ id: newest.visitId, userId: staff._id, status: 'CONFIRMED', now: new Date(NOW.getTime() + 3600e3) });
    const { visits } = await listVisits({ query: {}, now: new Date(NOW.getTime() + 3600e3) });
    expect(visits.map((v) => v.scheduledAt.slice(5, 10))).toEqual(['11-14', '11-12', '11-15', '11-16']);
    expect(visits.map((v) => v.isNewRequest)).toEqual([true, false, false, false]);
  });

  it('cancelling a pinned visit also releases it', async () => {
    seed();
    const newest = (await list()).visits[0];
    await changeVisitStatus({ id: newest.visitId, userId: staff._id, status: 'CANCELLED', now: NOW, reasonCode: 'SHOWROOM_BUSY' });
    const { visits } = await list();
    const cancelled = visits.find((v) => v.visitId === newest.visitId);
    expect(cancelled.isNewRequest).toBe(false);
    expect(visits[0].visitId).not.toBe(newest.visitId);
  });

  it('GET /appointments/:id carries the same flag', async () => {
    seed();
    const pinned = (await list()).visits[0];
    expect((await getVisit({ id: pinned.visitId, now: NOW })).isNewRequest).toBe(true);
    const plain = (await list()).visits[3];
    expect((await getVisit({ id: plain.visitId, now: NOW })).isNewRequest).toBe(false);
  });
});

describe('`sort` query validation (REQ-043)', () => {
  const check = (query) => staffListQuery.validate(query, { abortEarly: false });

  it('accepts asc and desc, and works without sort', () => {
    expect(check({ sort: 'asc' }).error).toBeUndefined();
    expect(check({ sort: 'desc' }).error).toBeUndefined();
    expect(check({}).error).toBeUndefined();
  });

  it('rejects anything else', () => {
    expect(check({ sort: 'abc' }).error).toBeDefined();
    expect(check({ sort: '' }).error).toBeDefined();
    expect(check({ sort: 'ASC' }).error).toBeDefined();
  });

  it('combines with the other filters', () => {
    expect(check({ sort: 'desc', status: 'PENDING', needsReminderCall: true, from: '2026-11-10', page: 1, limit: 20 }).error).toBeUndefined();
  });
});
