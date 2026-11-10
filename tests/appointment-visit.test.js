/**
 * @file appointment-visit.test.js
 * @description Pure visit rules and DTO mappers: grouping, derived status, who
 * cancelled, "late cancel" flag, staff transitions, allow-list output (no leaks).
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-014, 016, 018, 019, 024; AC-01, 14, 15, 17, 18, 19)
 */

import {
  groupIntoVisits, deriveVisitStatus, visitCodeOf, cancellationOf, isLateCancellation, canTransition,
  rescheduleBlock, canSelfReschedule, needsReminderCall, needsOutcome, customerExtras,
} from '../src/services/appointmentVisitRules.js';
import { toCustomerVisit, toStaffVisit } from '../src/services/appointmentVisitMapper.js';

const T = (iso) => new Date(iso);
const SLOT = T('2026-11-10T03:00:00Z');
const BOOKED = T('2026-11-08T03:00:00Z');
const hex = (n) => String(n).padStart(24, '0');

const mkRow = (n, extra = {}) => ({
  _id: hex(n), appointmentCode: `APT-${String(n).padStart(4, '0')}`, customer: hex(900), car: hex(500 + n),
  type: 'TEST_DRIVE', scheduledAt: SLOT, durationMinutes: 90, location: 'Showroom', notes: 'ghi chu',
  status: 'PENDING', isActive: true, createdBy: hex(800), updatedBy: null, createdAt: BOOKED, updatedAt: BOOKED,
  cancellationReason: null, assignedTo: null, confirmedBy: null, confirmedAt: null, completedAt: null, outcome: null,
  ...extra,
});

describe('groupIntoVisits', () => {
  it('groups by customer + scheduledAt, ignores hidden rows, visitId = smallest _id (AC-14)', () => {
    const rows = [
      mkRow(12), mkRow(10), mkRow(11, { scheduledAt: T('2026-11-11T03:00:00Z') }),
      mkRow(13, { customer: hex(901) }), mkRow(14, { isActive: false }),
    ];
    const visits = groupIntoVisits(rows);
    expect(visits).toHaveLength(3);
    const first = visits.find((v) => v.rows.length === 2);
    expect(first.visitId).toBe(hex(10));
    expect(first.rows.map((r) => r._id)).toEqual([hex(10), hex(12)]);
  });
});

describe('deriveVisitStatus / visitCodeOf', () => {
  it.each([
    [['PENDING', 'CANCELLED'], 'PENDING'],
    [['CONFIRMED', 'CANCELLED'], 'CONFIRMED'],
    [['COMPLETED', 'CANCELLED'], 'COMPLETED'],
    [['NO_SHOW', 'CANCELLED'], 'NO_SHOW'],
    [['CANCELLED', 'CANCELLED'], 'CANCELLED'],
  ])('%j → %s', (statuses, expected) => {
    expect(deriveVisitStatus(statuses.map((status, i) => mkRow(i + 1, { status })))).toBe(expected);
  });

  it('uses the smallest appointment code, also past APT-9999', () => {
    expect(visitCodeOf([mkRow(8), mkRow(7)])).toBe('APT-0007');
    expect(visitCodeOf([{ appointmentCode: 'APT-00010000' }, { appointmentCode: 'APT-9999' }])).toBe('APT-9999');
  });
});

describe('cancellationOf', () => {
  it('is null unless the whole visit is cancelled', () => {
    expect(cancellationOf([mkRow(1, { status: 'CANCELLED' }), mkRow(2)])).toBeNull();
  });

  it('CAR_UNAVAILABLE when every row was auto-cancelled; the reason is hidden', () => {
    const rows = [1, 2].map((n) => mkRow(n, { status: 'CANCELLED', cancellationReason: 'AUTO_CAR_UNAVAILABLE:RESERVED' }));
    expect(cancellationOf(rows)).toMatchObject({ type: 'CAR_UNAVAILABLE', reason: null });
  });

  // 1.1.0 (C21): the type depends on the reason alone, never on who created the visit.
  it('STAFF only for a `<CODE>|<note>` value: the customer sees the label, the note stays apart', () => {
    const customer = mkRow(1, { status: 'CANCELLED', cancellationReason: 'bận', updatedBy: hex(800) });
    const staff = mkRow(2, { status: 'CANCELLED', cancellationReason: 'SHOWROOM_BUSY|gọi 2 lần', updatedBy: hex(777) });
    expect(cancellationOf([customer])).toMatchObject({ type: 'CUSTOMER', reason: 'bận', note: null });
    expect(cancellationOf([staff])).toMatchObject({ type: 'STAFF', reason: 'Showroom có việc đột xuất', note: 'gọi 2 lần' });
  });

  it('a visit created by staff but cancelled by the customer is still CUSTOMER (INV-13)', () => {
    const row = mkRow(1, { status: 'CANCELLED', cancellationReason: 'đổi ý', createdBy: hex(777), updatedBy: hex(800) });
    expect(cancellationOf([row])).toMatchObject({ type: 'CUSTOMER', reason: 'đổi ý' });
  });

  it('text that only looks like a staff value is a customer value (unknown code, wrong case)', () => {
    ['NOPE|x', 'other|x', 'OTHER x'].forEach((text) => {
      expect(cancellationOf([mkRow(1, { status: 'CANCELLED', cancellationReason: text })])).toMatchObject({ type: 'CUSTOMER', reason: text });
    });
  });

  it('a human cancellation outranks an earlier auto-cancelled row of the same visit', () => {
    const auto = mkRow(1, { status: 'CANCELLED', cancellationReason: 'AUTO_CAR_UNAVAILABLE:SOLD' });
    const human = mkRow(2, { status: 'CANCELLED', cancellationReason: 'đổi ý', updatedBy: hex(800) });
    expect(cancellationOf([auto, human])).toMatchObject({ type: 'CUSTOMER', reason: 'đổi ý' });
  });
});

describe('isLateCancellation (C4, AC-15)', () => {
  it('not late when cancelled 12 hours or more before the visit', () => {
    expect(isLateCancellation(SLOT, BOOKED, new Date(SLOT.getTime() - 12 * 3600e3))).toBe(false);
  });

  it('late when under 12 hours before the visit', () => {
    expect(isLateCancellation(SLOT, BOOKED, new Date(SLOT.getTime() - 11 * 3600e3))).toBe(true);
  });

  it('never late within the first 30 minutes after booking, even close to the visit', () => {
    const booked = new Date(SLOT.getTime() - 3 * 3600e3);
    expect(isLateCancellation(SLOT, booked, new Date(booked.getTime() + 29 * 60e3))).toBe(false);
    expect(isLateCancellation(SLOT, booked, new Date(booked.getTime() + 31 * 60e3))).toBe(true);
  });
});

// ── 1.1.0: customer self-service reschedule rule (REQ-031/032, C17) ───────────
describe('rescheduleBlock / canSelfReschedule', () => {
  const visitAt = (scheduledAt, rows = [mkRow(1, { scheduledAt })]) => ({ scheduledAt, rows });
  const hoursBefore = (h) => new Date(SLOT.getTime() - h * 3600e3);

  it('allowed with 12 hours or more to go and fewer than 2 earlier reschedules', () => {
    expect(rescheduleBlock(visitAt(SLOT), 0, hoursBefore(12))).toBeNull();
    expect(canSelfReschedule(visitAt(SLOT), 1, hoursBefore(30))).toBe(true);
  });

  it('NOT_ALLOWED with under 12 hours to go, after the start, or with no open appointment', () => {
    expect(rescheduleBlock(visitAt(SLOT), 0, new Date(hoursBefore(12).getTime() + 1))).toBe('NOT_ALLOWED');
    expect(rescheduleBlock(visitAt(SLOT), 0, new Date(SLOT.getTime() + 1))).toBe('NOT_ALLOWED');
    const closed = visitAt(SLOT, [mkRow(1, { status: 'CANCELLED' }), mkRow(2, { status: 'COMPLETED' })]);
    expect(rescheduleBlock(closed, 0, hoursBefore(48))).toBe('NOT_ALLOWED');
    const hidden = visitAt(SLOT, [mkRow(1, { isActive: false })]);
    expect(canSelfReschedule(hidden, 0, hoursBefore(48))).toBe(false);
  });

  it('LIMIT after 2 reschedules; NOT_ALLOWED outranks LIMIT', () => {
    expect(rescheduleBlock(visitAt(SLOT), 2, hoursBefore(48))).toBe('LIMIT');
    expect(rescheduleBlock(visitAt(SLOT), 3, hoursBefore(48))).toBe('LIMIT');
    expect(rescheduleBlock(visitAt(SLOT), 2, hoursBefore(1))).toBe('NOT_ALLOWED');
  });

  it('one open appointment among closed ones is enough', () => {
    const mixed = visitAt(SLOT, [mkRow(1, { status: 'CANCELLED', cancellationReason: 'AUTO_CAR_UNAVAILABLE:SOLD' }), mkRow(2)]);
    expect(canSelfReschedule(mixed, 0, hoursBefore(48))).toBe(true);
  });
});

// ── 1.1.0: staff reminders (C26, REQ-037; AC-35) ──────────────────────────────
describe('needsReminderCall / needsOutcome', () => {
  const visitOf = (rows) => ({ scheduledAt: SLOT, rows });
  const minutesFromStart = (m) => new Date(SLOT.getTime() + m * 60e3);

  it('a CONFIRMED visit needs a reminder call from 30 minutes before its start until it starts', () => {
    const confirmed = visitOf([mkRow(1, { status: 'CONFIRMED' })]);
    expect(needsReminderCall(confirmed, minutesFromStart(-31))).toBe(false);
    expect(needsReminderCall(confirmed, minutesFromStart(-30))).toBe(true);
    expect(needsReminderCall(confirmed, minutesFromStart(-15))).toBe(true);
    expect(needsReminderCall(confirmed, minutesFromStart(0))).toBe(true);
    expect(needsReminderCall(confirmed, minutesFromStart(1))).toBe(false);
  });

  it('only a CONFIRMED visit: a PENDING one has not been called yet, a closed one needs nothing', () => {
    expect(needsReminderCall(visitOf([mkRow(1)]), minutesFromStart(-15))).toBe(false);
    expect(needsReminderCall(visitOf([mkRow(1, { status: 'CANCELLED' })]), minutesFromStart(-15))).toBe(false);
    expect(needsReminderCall(visitOf([mkRow(1, { status: 'COMPLETED' })]), minutesFromStart(-15))).toBe(false);
  });

  it('needsOutcome: still open after start + duration (90 min), for PENDING and CONFIRMED alike', () => {
    const open = visitOf([mkRow(1, { status: 'CONFIRMED' })]);
    expect(needsOutcome(open, minutesFromStart(-10))).toBe(false);
    expect(needsOutcome(open, minutesFromStart(90))).toBe(false); // exactly at the end: not yet
    expect(needsOutcome(open, minutesFromStart(91))).toBe(true);
    expect(needsOutcome(visitOf([mkRow(1)]), minutesFromStart(500))).toBe(true);
  });

  it('needsOutcome is false once everything is closed or hidden', () => {
    expect(needsOutcome(visitOf([mkRow(1, { status: 'COMPLETED' })]), minutesFromStart(500))).toBe(false);
    expect(needsOutcome(visitOf([mkRow(1, { status: 'NO_SHOW' })]), minutesFromStart(500))).toBe(false);
    expect(needsOutcome(visitOf([mkRow(1, { status: 'CANCELLED' })]), minutesFromStart(500))).toBe(false);
    expect(needsOutcome(visitOf([mkRow(1, { isActive: false })]), minutesFromStart(500))).toBe(false);
  });

  it('customerExtras bundles the count with whether a move is still possible', () => {
    const early = new Date(SLOT.getTime() - 48 * 3600e3);
    expect(customerExtras(visitOf([mkRow(1)]), 1, early)).toEqual({ rescheduleCount: 1, canReschedule: true });
    expect(customerExtras(visitOf([mkRow(1)]), 2, early)).toEqual({ rescheduleCount: 2, canReschedule: false });
  });
});

describe('canTransition (C5, AC-19)', () => {
  const before = new Date(SLOT.getTime() - 3600e3);
  const after = new Date(SLOT.getTime() + 3600e3);

  it('allows the documented moves', () => {
    expect(canTransition('PENDING', 'CONFIRMED', SLOT, before)).toBe(true);
    expect(canTransition('PENDING', 'CANCELLED', SLOT, before)).toBe(true);
    expect(canTransition('CONFIRMED', 'CANCELLED', SLOT, before)).toBe(true);
    expect(canTransition('CONFIRMED', 'COMPLETED', SLOT, after)).toBe(true);
    expect(canTransition('CONFIRMED', 'NO_SHOW', SLOT, after)).toBe(true);
  });

  it('rejects everything else, including COMPLETED / NO_SHOW before the visit time', () => {
    expect(canTransition('PENDING', 'COMPLETED', SLOT, after)).toBe(false);
    expect(canTransition('COMPLETED', 'CONFIRMED', SLOT, after)).toBe(false);
    expect(canTransition('CANCELLED', 'CONFIRMED', SLOT, before)).toBe(false);
    expect(canTransition('CONFIRMED', 'COMPLETED', SLOT, before)).toBe(false);
    expect(canTransition('CONFIRMED', 'NO_SHOW', SLOT, before)).toBe(false);
  });
});

// ── DTO allow-list (REQ-024) ─────────────────────────────────────────────────

const FORBIDDEN = [
  'passwordHash', 'token', 'internalNotes', 'floorPrice', 'originalPrice', 'priceHistory', 'vin', 'licensePlate',
  'createdBy', 'updatedBy', 'publicId', 'isActive',
];
const keysDeep = (value, out = new Set()) => {
  if (Array.isArray(value)) value.forEach((item) => keysDeep(item, out));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => { out.add(k); keysDeep(v, out); });
  return out;
};

const car = (n) => ({
  _id: hex(500 + n), vehicleCode: `TC-2026-00${n}`, make: 'MAZDA', model: 'CX-5', variant: '2.0', year: 2020, status: 'AVAILABLE',
  images: [{ url: 'https://img/a.jpg', publicId: 'secret-a', isPrimary: false }, { url: 'https://img/b.jpg', publicId: 'secret-b', isPrimary: true }],
  internalNotes: 'x', floorPrice: 1, originalPrice: 2, priceHistory: [1], vin: 'VIN', licensePlate: '51A', passwordHash: 'h',
});
const carsById = new Map([1, 2].map((n) => [hex(500 + n), car(n)]));

describe('DTO mappers (REQ-024, AC-01, AC-14)', () => {
  const dirty = (n) => mkRow(n, {
    assignedTo: hex(700), confirmedBy: hex(700), confirmedAt: BOOKED, outcome: 'rất hài lòng', updatedBy: hex(700), passwordHash: 'h', token: 't',
  });
  const visit = groupIntoVisits([dirty(2), dirty(1)])[0];

  it('customer view shows exactly the contracted keys and no forbidden or internal field', () => {
    const dto = toCustomerVisit(visit, carsById);
    expect(Object.keys(dto).sort()).toEqual([
      'appointments', 'canReschedule', 'cancellationReason', 'cancellationType', 'createdAt', 'durationMinutes', 'isLateCancellation',
      'location', 'notes', 'rescheduleCount', 'scheduledAt', 'status', 'type', 'visitCode', 'visitId', // 1.1.0: canReschedule, rescheduleCount
    ]);
    expect(Object.keys(dto.appointments[0].car).sort()).toEqual(
      ['_id', 'make', 'model', 'primaryImageUrl', 'variant', 'vehicleCode', 'year'],
    );
    const keys = keysDeep(dto);
    [...FORBIDDEN, 'assignedTo', 'confirmedBy', 'outcome', 'customer'].forEach((k) => expect(keys.has(k)).toBe(false));
    expect(dto.appointments.map((a) => a.appointmentCode)).toEqual(['APT-0001', 'APT-0002']);
    expect(dto.appointments[0].car.primaryImageUrl).toBe('https://img/b.jpg');
    expect(dto.scheduledAt).toBe('2026-11-10T03:00:00.000Z');
  });

  it('staff view adds customer contact, handlers, outcome and car.status, still without forbidden fields', () => {
    const customers = new Map([[hex(900), { _id: hex(900), fullName: 'Khách A', phone: '0900', email: 'a@x.vn', passwordHash: 'h' }]]);
    const users = new Map([[hex(700), { _id: hex(700), fullName: 'Nhân viên', passwordHash: 'h' }]]);
    const dto = toStaffVisit(visit, carsById, customers, users);
    expect(dto.customer).toEqual({ _id: hex(900), fullName: 'Khách A', phone: '0900', email: 'a@x.vn' });
    expect(dto.assignedTo).toEqual({ _id: hex(700), fullName: 'Nhân viên' });
    expect(dto.confirmedBy).toEqual({ _id: hex(700), fullName: 'Nhân viên' });
    expect(dto.outcome).toBe('rất hài lòng');
    expect(dto.appointments[0].car.status).toBe('AVAILABLE');
    const keys = keysDeep(dto);
    FORBIDDEN.forEach((k) => expect(keys.has(k)).toBe(false));
  });

  it('1.1.0: the customer gets only rescheduleCount and canReschedule; the staff view also gets the reminder flags and the internal note', () => {
    const customerDto = toCustomerVisit(visit, carsById, { rescheduleCount: 1, canReschedule: true, needsReminderCall: true, cancellationNote: 'x' });
    expect(customerDto).toMatchObject({ rescheduleCount: 1, canReschedule: true });
    expect(keysDeep(customerDto).has('needsReminderCall')).toBe(false);
    expect(keysDeep(customerDto).has('cancellationNote')).toBe(false);
    const staffDto = toStaffVisit(visit, carsById, new Map(), new Map(), { rescheduleCount: 2, needsReminderCall: true, needsOutcome: true });
    expect(staffDto).toMatchObject({ rescheduleCount: 2, needsReminderCall: true, needsOutcome: true, cancellationNote: null });
    expect(toCustomerVisit(visit, carsById)).toMatchObject({ rescheduleCount: 0, canReschedule: false }); // safe defaults
    expect(toStaffVisit(visit, carsById, new Map(), new Map())).toMatchObject({ needsReminderCall: false, needsOutcome: false });
  });

  it('tolerates a car that no longer exists in the lookup', () => {
    const dto = toCustomerVisit(groupIntoVisits([mkRow(3)])[0], new Map());
    expect(dto.appointments[0].car).toMatchObject({ _id: hex(503), vehicleCode: null, primaryImageUrl: null });
  });

  it('marks a customer cancellation as late only when the flag rules say so', () => {
    const cancelledAt = new Date(SLOT.getTime() - 5 * 3600e3);
    const rows = [mkRow(1, { status: 'CANCELLED', updatedBy: hex(800), cancellationReason: 'bận', updatedAt: cancelledAt })];
    const dto = toCustomerVisit(groupIntoVisits(rows)[0], carsById);
    expect(dto).toMatchObject({ status: 'CANCELLED', cancellationType: 'CUSTOMER', cancellationReason: 'bận', isLateCancellation: true });
  });

  it('hides the reason of an auto-cancelled visit and never calls it late', () => {
    const rows = [mkRow(1, { status: 'CANCELLED', cancellationReason: 'AUTO_CAR_UNAVAILABLE:SOLD', updatedAt: new Date(SLOT.getTime() - 3600e3) })];
    const dto = toCustomerVisit(groupIntoVisits(rows)[0], carsById);
    expect(dto).toMatchObject({ cancellationType: 'CAR_UNAVAILABLE', cancellationReason: null, isLateCancellation: false });
  });
});
