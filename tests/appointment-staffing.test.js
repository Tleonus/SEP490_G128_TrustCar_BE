/**
 * @file appointment-staffing.test.js
 * @description Test-drive staffing: one open visit keeps one sales staff member busy, so a slot
 * holds min(Admin ceiling, staff at work that day) visits; new / moved / confirmed visits get a
 * free person; staff can hand a visit to another free person; attendance ("điểm danh") takes
 * people out for a day and re-staffs that day without cancelling anything.
 */

import { jest } from '@jest/globals';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { buildStaffing, capacityOn, needsStaff, pickStaff } from '../src/services/appointmentStaffing.js';
import { createVisit } from '../src/services/appointmentBookingService.js';
import { createVisitForCustomer } from '../src/services/appointmentStaffBookingService.js';
import { rescheduleVisitAsStaff } from '../src/services/appointmentRescheduleService.js';
import { changeVisitStatus, listVisits } from '../src/services/appointmentStaffService.js';
import { listAssigneeOptions, reassignVisit } from '../src/services/appointmentAssigneeService.js';
import { getSlots } from '../src/services/appointmentSlotService.js';
import { getStaffSlots } from '../src/services/appointmentStaffSlotService.js';
import { getAttendance, setPresence, setAttendanceKeeper, canTakeAttendance } from '../src/services/staffAttendanceService.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';

const fakes = await setupAppointmentFakes();
const logSpy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const NOW = new Date('2026-11-08T00:00:00Z');
const DAY = '2026-11-10';
const SLOT = new Date('2026-11-10T03:00:00Z'); // Tue 10:00 VN
const SLOT_PM = new Date('2026-11-10T06:00:00Z'); // Tue 13:00 VN
const NEXT_DAY_SLOT = new Date('2026-11-11T03:00:00Z');

const reject = (promise) => promise.then(() => null, (error) => error);
const idOf = (value) => (value ? String(value) : null);
let an; let binh; let chi; let admin;

const customer = () => {
  const c = fakes.addCustomer();
  fakes.addUser({ customer: c._id, roleName: 'CUSTOMER', isActive: true });
  return c;
};
const book = (c, scheduledAt = SLOT) => createVisit({
  userId: c._id, customerId: c._id, carIds: [String(fakes.addCar()._id)], scheduledAt, now: NOW,
});
const rowsOf = (visit) => fakes.appointments.filter((row) => row.isActive && idOf(row.customer) === idOf(visit.customer)
  && new Date(row.scheduledAt).getTime() === new Date(visit.scheduledAt ?? row.scheduledAt).getTime());
const assigneeOfVisit = (visitId) => {
  const anchor = fakes.appointments.find((row) => idOf(row._id) === visitId);
  return idOf(fakes.appointments.find((row) => row.isActive && idOf(row.customer) === idOf(anchor.customer)
    && new Date(row.scheduledAt).getTime() === new Date(anchor.scheduledAt).getTime())?.assignedTo);
};

beforeEach(() => {
  fakes.reset(); logSpy.mockClear();
  fakes.capacity = 3; // Admin ceiling
  fakes.enableStaffing();
  an = fakes.addStaff({ fullName: 'An Sales' });
  binh = fakes.addStaff({ fullName: 'Bình Sales' });
  chi = fakes.addStaff({ fullName: 'Chi Sales', isActive: false }); // left the company: never counted
  admin = fakes.addUser({ fullName: 'Admin', roleName: 'ADMIN', roleNames: ['ADMIN'], isActive: true });
});

describe('pure rules', () => {
  const staff = [{ _id: 'a', fullName: 'An' }, { _id: 'b', fullName: 'Bình' }, { _id: 'c', fullName: 'Chi' }];
  const row = (person, customer, at = SLOT) => ({ _id: `${person}-${customer}`, assignedTo: person, customer, scheduledAt: at, status: 'CONFIRMED', isActive: true });

  it('capacity = min(Admin ceiling, staff at work that day)', () => {
    const staffing = buildStaffing({ staff, absences: [{ date: DAY, user: 'a' }, { date: DAY, user: 'b' }] });
    expect(capacityOn(staffing, DAY, 3)).toBe(1);
    expect(capacityOn(staffing, '2026-11-11', 2)).toBe(2);
    expect(capacityOn(null, DAY, 3)).toBe(3); // staffing off
  });

  it('picks the preferred person when free, else the least loaded, else nobody', () => {
    const dayRows = [row('a', 'x', SLOT_PM), row('a', 'y', NEXT_DAY_SLOT), row('b', 'z', SLOT_PM)];
    expect(pickStaff({ available: staff, slotRows: [], dayRows, prefer: 'b' })).toBe('b');
    expect(pickStaff({ available: staff, slotRows: [], dayRows })).toBe('c'); // nobody else has 0
    expect(pickStaff({ available: staff, slotRows: [row('c', 'q')], dayRows })).toBe('b'); // a has 2, b has 1
    expect(pickStaff({ available: staff, slotRows: [row('a', 1), row('b', 2), row('c', 3)], prefer: 'a' })).toBeNull();
    // the visit's own rows never make its person busy
    expect(pickStaff({ available: staff.slice(0, 1), slotRows: [row('a', 'me')], skipRowIds: ['a-me'] })).toBe('a');
  });

  it('flags an upcoming open visit with nobody at work assigned', () => {
    const staffing = buildStaffing({ staff, absences: [{ date: DAY, user: 'b' }] });
    const visit = (assignedTo, at = SLOT, status = 'PENDING') => ({ scheduledAt: at, rows: [{ assignedTo, status, isActive: true, type: 'TEST_DRIVE' }] });
    expect(needsStaff(visit('a'), staffing, NOW)).toBe(false);
    expect(needsStaff(visit(null), staffing, NOW)).toBe(true);
    expect(needsStaff(visit('b'), staffing, NOW)).toBe(true); // off that day
    expect(needsStaff(visit('zz'), staffing, NOW)).toBe(true); // not sales staff
    expect(needsStaff(visit(null, SLOT, 'COMPLETED'), staffing, NOW)).toBe(false);
    expect(needsStaff(visit(null), staffing, new Date('2026-11-10T04:00:00Z'))).toBe(false); // started
    expect(needsStaff(visit(null), null, NOW)).toBe(false);
  });
});

describe('booking takes a free staff member; no free staff → slot full', () => {
  it('each new visit gets a different person; the third customer is refused although the ceiling is 3', async () => {
    const v1 = await book(customer());
    const v2 = await book(customer());
    expect(new Set([assigneeOfVisit(v1.visitId), assigneeOfVisit(v2.visitId)])).toEqual(new Set([idOf(an._id), idOf(binh._id)]));
    const error = await reject(book(customer()));
    expect(error.code).toBe('APPOINTMENT_CAPACITY_FULL');
    expect((await book(customer(), SLOT_PM)).visitId).toBeTruthy(); // another slot is still free
  });

  it('a person marked off that day does not count; other days are untouched', async () => {
    fakes.markAttendance(binh, DAY);
    await book(customer());
    expect((await reject(book(customer()))).code).toBe('APPOINTMENT_CAPACITY_FULL');
    await book(customer(), NEXT_DAY_SLOT);
    await book(customer(), NEXT_DAY_SLOT);
  });

  it('nobody at work → every slot of the day is full', async () => {
    fakes.markAttendance(an, DAY); fakes.markAttendance(binh, DAY);
    expect((await reject(book(customer()))).code).toBe('APPOINTMENT_CAPACITY_FULL');
    const { days } = await getSlots({ customerId: customer()._id, carIds: [String(fakes.addCar()._id)], from: DAY, to: DAY, now: NOW });
    expect(days[0].slots.every((slot) => slot.reason === 'CAPACITY_FULL')).toBe(true);
  });

  it('the day is balanced: the next visit goes to whoever has fewer visits that day', async () => {
    await book(customer(), SLOT_PM); // An (alphabetical tie-break)
    const morning = await book(customer(), SLOT);
    expect(assigneeOfVisit(morning.visitId)).toBe(idOf(binh._id));
  });

  it('the staff grid shows how many are at work, places left and who handles each visit', async () => {
    fakes.markAttendance(binh, DAY);
    await book(customer());
    const { days } = await getStaffSlots({ from: DAY, to: DAY, now: NOW });
    const slot = days[0].slots.find((s) => s.start.includes('T10:00'));
    expect(slot).toMatchObject({ staffAtWork: 1, capacityRemaining: 0, reason: 'CAPACITY_FULL' });
    expect(slot.visits[0].assignedTo).toEqual({ _id: idOf(an._id), fullName: 'An Sales' });
  });
});

describe('staff booking, moving and confirming', () => {
  it('the booking sales staff member goes with the customer when free; an ADMIN booking picks a free salesperson', async () => {
    const mine = await createVisitForCustomer({ userId: binh._id, customerId: customer()._id, carIds: [String(fakes.addCar()._id)], scheduledAt: SLOT, now: NOW });
    expect(mine.assignedTo).toEqual({ _id: idOf(binh._id), fullName: 'Bình Sales' });
    const byAdmin = await createVisitForCustomer({ userId: admin._id, customerId: customer()._id, carIds: [String(fakes.addCar()._id)], scheduledAt: SLOT, now: NOW });
    expect(byAdmin.assignedTo._id).toBe(idOf(an._id));
  });

  it('a moved visit keeps its person when free in the new slot, else gets a free one', async () => {
    const v1 = await book(customer()); // An
    const { visit } = await rescheduleVisitAsStaff({ id: v1.visitId, userId: admin._id, scheduledAt: SLOT_PM, now: NOW });
    expect(visit.assignedTo._id).toBe(idOf(an._id));
    await book(customer(), NEXT_DAY_SLOT); // An
    const { visit: moved } = await rescheduleVisitAsStaff({ id: visit.visitId, userId: admin._id, scheduledAt: NEXT_DAY_SLOT, now: NOW });
    expect(moved.assignedTo._id).toBe(idOf(binh._id));
  });

  it('confirming an old visit without anybody assigns the confirming salesperson', async () => {
    const c = customer();
    fakes.addAppointment({ customer: c._id, car: fakes.addCar()._id, scheduledAt: SLOT, status: 'PENDING', holdsCar: true, visitSeat: 1 });
    const id = fakes.appointments[0]._id;
    const visit = await changeVisitStatus({ id, userId: binh._id, status: 'CONFIRMED', now: NOW });
    expect(visit.assignedTo._id).toBe(idOf(binh._id));
    expect(visit.needsStaff).toBe(false);
  });
});

describe('reassigning a visit', () => {
  it('lists people at work with busy/free, then moves the visit to a free one', async () => {
    const v1 = await book(customer()); // An
    const { options, current, editable } = await listAssigneeOptions({ id: v1.visitId, now: NOW });
    expect(editable).toBe(true);
    expect(current).toBe(idOf(an._id));
    expect(options.map((o) => [o.fullName, o.busy, o.current])).toEqual([['An Sales', false, true], ['Bình Sales', false, false]]);
    await reassignVisit({ id: v1.visitId, staffId: idOf(binh._id), userId: admin._id, now: NOW });
    expect(assigneeOfVisit(v1.visitId)).toBe(idOf(binh._id));
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'APPOINTMENT_REASSIGNED' }));
  });

  it('refuses a busy person, a person off that day, a non-salesperson and a past visit', async () => {
    const v1 = await book(customer()); // An
    await book(customer()); // Bình
    expect((await reject(reassignVisit({ id: v1.visitId, staffId: idOf(binh._id), userId: admin._id, now: NOW }))).code).toBe('APPOINTMENT_STAFF_BUSY');
    expect((await reject(reassignVisit({ id: v1.visitId, staffId: idOf(admin._id), userId: admin._id, now: NOW }))).code).toBe('APPOINTMENT_STAFF_UNAVAILABLE');
    expect((await reject(reassignVisit({ id: v1.visitId, staffId: idOf(chi._id), userId: admin._id, now: NOW }))).code).toBe('APPOINTMENT_STAFF_UNAVAILABLE');
    const late = new Date('2026-11-10T05:00:00Z');
    expect((await reject(reassignVisit({ id: v1.visitId, staffId: idOf(an._id), userId: admin._id, now: late }))).code).toBe('APPOINTMENT_STAFF_NOT_OPEN');
  });
});

describe('attendance (điểm danh)', () => {
  it('everyone is at work by default; the sheet counts each person\'s visits', async () => {
    await book(customer());
    const sheet = await getAttendance({ date: DAY, now: NOW });
    expect(sheet).toMatchObject({ date: DAY, editable: true, presentCount: 2, total: 2 });
    expect(sheet.staff.map((p) => [p.fullName, p.present, p.visitsThatDay])).toEqual([['An Sales', true, 1], ['Bình Sales', true, 0]]);
  });

  it('marking someone off hands their visits to a free colleague; with nobody free the visit is flagged, never cancelled', async () => {
    const v1 = await book(customer()); // An 10:00
    const result = await setPresence({ date: DAY, staffId: an._id, present: false, userId: admin._id, now: NOW });
    expect(result.reassigned).toEqual([expect.objectContaining({ from: idOf(an._id), to: idOf(binh._id) })]);
    expect(assigneeOfVisit(v1.visitId)).toBe(idOf(binh._id));

    const off = await setPresence({ date: DAY, staffId: binh._id, present: false, userId: admin._id, now: NOW });
    expect(off.unassigned).toHaveLength(1);
    expect(rowsOf(v1).every((row) => row.status === 'PENDING' && row.assignedTo === null)).toBe(true);
    const { visits } = await listVisits({ query: { needsStaff: true }, userId: admin._id, now: NOW });
    expect(visits.map((v) => [v.visitId, v.needsStaff])).toEqual([[v1.visitId, true]]);

    const back = await setPresence({ date: DAY, staffId: an._id, present: true, userId: admin._id, now: NOW });
    expect(back.reassigned).toEqual([expect.objectContaining({ from: null, to: idOf(an._id) })]);
    expect((await getAttendance({ date: DAY, now: NOW })).staff.map((p) => p.present)).toEqual([true, false]);
  });

  it('past days are closed; only active sales staff can be marked', async () => {
    expect((await reject(setPresence({ date: '2026-11-07', staffId: an._id, present: false, userId: admin._id, now: NOW }))).code).toBe('ATTENDANCE_DAY_CLOSED');
    expect((await reject(setPresence({ date: DAY, staffId: chi._id, present: false, userId: admin._id, now: NOW }))).code).toBe('ATTENDANCE_STAFF_NOT_FOUND');
    expect((await getAttendance({ date: '2026-11-07', now: NOW })).editable).toBe(false);
  });

  it('an ADMIN lets a salesperson take attendance', async () => {
    expect(canTakeAttendance({ isAdmin: false, user: an })).toBe(false);
    await setAttendanceKeeper({ staffId: an._id, enabled: true, userId: admin._id });
    expect(canTakeAttendance({ isAdmin: false, user: fakes.state.users.find((u) => u === an) })).toBe(true);
    expect(canTakeAttendance({ isAdmin: true, user: null })).toBe(true);
    expect((await getAttendance({ date: DAY, now: NOW })).staff[0].canTakeAttendance).toBe(true);
  });
});
