/**
 * @file test-drive-staff.test.js
 * @description Staff handling of test drives: the transition table, reassignment,
 * attention flags and audit entries.
 */

import { setupTestDriveHarness } from './helpers/fakeTestDriveModels.js';

const h = await setupTestDriveHarness();
const { default: mongoose } = await import('mongoose');
const staffService = await import('../src/services/testDriveStaffService.js');
const { computeLockedUntil } = await import('../src/services/testDriveLimits.js');

const HOUR = 60 * 60 * 1000;
const FUTURE = new Date(Date.now() + 72 * HOUR);
const STARTED = new Date(Date.now() - 30 * 60 * 1000);
const LONG_AGO = new Date(Date.now() - 5 * HOUR);
const PAGE = { page: 1, limit: 50, skip: 0 };

let actor;
let staffA;
let staffB;
let customer;

beforeEach(async () => {
  h.reset();
  actor = { _id: new mongoose.Types.ObjectId(), email: 'sales@trustcar.vn' };
  staffA = (await h.createUser({ roleName: 'SALES_STAFF', fullName: 'Nhan vien A' })).id;
  staffB = (await h.createUser({ roleName: 'SALES_STAFF', fullName: 'Nhan vien B' })).id;
  customer = await h.createCustomer({ email: 'khach@trustcar.vn' });
});

const book = (overrides = {}) => h.insertAppointment({
  appointmentCode: `APT-${h.appointments.size + 1}`, customer, car: h.createCar(), assignedTo: staffA, scheduledAt: FUTURE, slotSeat: 1, ...overrides,
});
const events = () => h.activity.map((entry) => entry.eventType);

describe('confirm', () => {
  test('PENDING becomes CONFIRMED with who and when', async () => {
    const id = book();
    await expect(staffService.confirm(id, actor)).resolves.toEqual({ id, status: 'CONFIRMED' });
    expect(String(h.appointment(id).confirmedBy)).toBe(String(actor._id));
    expect(h.appointment(id).confirmedAt).toBeInstanceOf(Date);
    expect(events()).toEqual(['APPOINTMENT_CONFIRMED']);
  });

  test('allowed until the end of the slot, refused after', async () => {
    await expect(staffService.confirm(book({ scheduledAt: STARTED, durationMinutes: 60 }), actor)).resolves.toMatchObject({ status: 'CONFIRMED' });
    await expect(staffService.confirm(book({ scheduledAt: LONG_AGO, durationMinutes: 60 }), actor)).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_TRANSITION' });
  });

  test('a write conflict retries and applies once', async () => {
    const id = book();
    h.Appointment.findOneAndUpdate.mockImplementationOnce(() => { throw h.writeConflict(); });
    await expect(staffService.confirm(id, actor)).resolves.toMatchObject({ status: 'CONFIRMED' });
    expect(events()).toEqual(['APPOINTMENT_CONFIRMED']);
  });

  test('an unknown id gives 404', async () => {
    await expect(staffService.confirm(new mongoose.Types.ObjectId(), actor)).rejects.toMatchObject({ statusCode: 404, code: 'TEST_DRIVE_NOT_FOUND' });
  });

  test('another appointment type is invisible here', async () => {
    await expect(staffService.confirm(book({ type: 'VIEWING' }), actor)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('outcome', () => {
  test('COMPLETED from a started CONFIRMED records the outcome and ends the hold', async () => {
    const id = book({ status: 'CONFIRMED', scheduledAt: STARTED });
    await expect(staffService.complete(id, 'Khách hài lòng', actor)).resolves.toMatchObject({ status: 'COMPLETED' });
    const stored = h.appointment(id);
    expect(stored.outcome).toBe('Khách hài lòng');
    expect(stored.completedAt).toBeInstanceOf(Date);
    expect(stored.slotSeat).toBeUndefined();
    expect(events()).toEqual(['APPOINTMENT_COMPLETED']);
  });

  test('NO_SHOW from a started CONFIRMED is audited', async () => {
    const id = book({ status: 'CONFIRMED', scheduledAt: STARTED });
    await expect(staffService.markNoShow(id, actor)).resolves.toMatchObject({ status: 'NO_SHOW' });
    expect(events()).toEqual(['APPOINTMENT_NO_SHOW']);
  });

  test.each([
    ['PENDING', { status: 'PENDING', scheduledAt: STARTED }],
    ['before the start', { status: 'CONFIRMED', scheduledAt: FUTURE }],
    ['already cancelled', { status: 'CANCELLED', scheduledAt: STARTED, slotSeat: undefined }],
  ])('refused when %s', async (_name, overrides) => {
    const id = book(overrides);
    await expect(staffService.complete(id, 'x', actor)).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_TRANSITION' });
    await expect(staffService.markNoShow(id, actor)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('correctNoShow', () => {
  test('turns a no-show into COMPLETED, audited, and lifts the lock', async () => {
    const id = book({ status: 'NO_SHOW', scheduledAt: LONG_AGO, slotSeat: undefined });
    await expect(staffService.correctNoShow(id, 'Khách đã đến', actor)).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(h.appointment(id).completedAt).toEqual(new Date(LONG_AGO.getTime() + HOUR));
    expect(events()).toEqual(['APPOINTMENT_NO_SHOW_CORRECTED']);
    expect(computeLockedUntil([LONG_AGO], new Date())).toBeNull();
  });

  test('only applies to a no-show', async () => {
    await expect(staffService.correctNoShow(book({ status: 'CONFIRMED', scheduledAt: STARTED }), 'x', actor)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('reassign', () => {
  test('moves to a free staff member and audits', async () => {
    const id = book();
    await staffService.reassign(id, staffB, actor);
    expect(String(h.appointment(id).assignedTo)).toBe(staffB);
    expect(events()).toEqual(['APPOINTMENT_REASSIGNED']);
  });

  test('refuses busy staff and non-staff accounts', async () => {
    const id = book();
    book({ assignedTo: staffB, slotSeat: 2 });
    const customerAccount = await h.createUser({ roleName: 'CUSTOMER', phone: '0909999999' });
    await expect(staffService.reassign(id, staffB, actor)).rejects.toMatchObject({ statusCode: 409, code: 'STAFF_NOT_AVAILABLE' });
    await expect(staffService.reassign(id, customerAccount.id, actor)).rejects.toMatchObject({ statusCode: 422, code: 'STAFF_INVALID' });
  });

  test('a closed appointment cannot be reassigned', async () => {
    await expect(staffService.reassign(book({ status: 'COMPLETED', slotSeat: undefined }), staffB, actor)).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_TRANSITION' });
  });

  test('the staff unique index covers a race the check missed', async () => {
    const id = book();
    const original = h.Appointment.find.getMockImplementation();
    // The busy check runs before the competing booking appears.
    h.Appointment.find.mockImplementationOnce(() => ({ select: () => ({ lean: async () => [] }) }));
    book({ assignedTo: staffB, slotSeat: 2 });
    await expect(staffService.reassign(id, staffB, actor)).rejects.toMatchObject({ statusCode: 409, code: 'STAFF_NOT_AVAILABLE' });
    expect(String(h.appointment(id).assignedTo)).toBe(staffA);
    h.Appointment.find.mockImplementation(original);
  });
});

describe('staffCancel', () => {
  test('stores reason and note, frees the seat, emails the customer', async () => {
    const id = book();
    await staffService.staffCancel(id, { reasonCode: 'OTHER', note: 'Xe đang bảo dưỡng' }, actor);
    const stored = h.appointment(id);
    expect(stored.status).toBe('CANCELLED');
    expect(stored.cancellationReason).toBe('Lý do khác: Xe đang bảo dưỡng');
    expect(stored.slotSeat).toBeUndefined();
    expect(h.mail.sent[0].to).toBe('khach@trustcar.vn');
  });

  test('a failed email still cancels', async () => {
    h.mail.fail = true;
    await expect(staffService.staffCancel(book(), { reasonCode: 'SLOT_FULL' }, actor)).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  test('a closed appointment gives 409', async () => {
    await expect(staffService.staffCancel(book({ status: 'COMPLETED', slotSeat: undefined }), { reasonCode: 'SLOT_FULL' }, actor))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('listAppointments', () => {
  const list = (query = {}) => staffService.listAppointments(query, PAGE);

  test('includes customer contact, car and staff, without internal fields', async () => {
    const id = book();
    const { items } = await list();
    expect(items[0]).toMatchObject({ id, status: 'PENDING', customer: { phone: '0901234567' }, assignedTo: { id: staffA }, needsAttention: false });
    expect(items[0]).not.toHaveProperty('slotSeat');
  });

  test('filters by status and staff', async () => {
    book();
    const confirmed = book({ status: 'CONFIRMED', assignedTo: staffB, slotSeat: 2 });
    expect((await list({ status: 'CONFIRMED' })).items.map((a) => a.id)).toEqual([confirmed]);
    expect((await list({ staffId: staffB })).items.map((a) => a.id)).toEqual([confirmed]);
  });

  test('filters by the Vietnam calendar day', async () => {
    const id = book({ scheduledAt: new Date('2030-01-15T23:30:00+07:00') });
    expect((await list({ date: '2030-01-15' })).items.map((a) => a.id)).toEqual([id]);
    expect((await list({ date: '2030-01-16' })).items).toEqual([]);
  });

  test('flags overdue PENDING, cars on hold and inactive staff, each with a reason', async () => {
    const overdue = book({ scheduledAt: LONG_AGO, durationMinutes: 60 });
    const onHold = book({ car: h.createCar({ status: 'RESERVED' }), slotSeat: 2, assignedTo: staffB });
    const inactiveStaff = (await h.createUser({ roleName: 'SALES_STAFF', isActive: false })).id;
    const staffGone = book({ assignedTo: inactiveStaff, slotSeat: 3 });
    const fine = book({ assignedTo: new mongoose.Types.ObjectId(), scheduledAt: new Date(FUTURE.getTime() + HOUR), slotSeat: 1 });

    const { items, pagination } = await list({ needsAttention: true });

    expect(pagination.total).toBe(3);
    const reasons = Object.fromEntries(items.map((a) => [a.id, a.attentionReasons]));
    expect(reasons[overdue]).toEqual(['PENDING_OVERDUE']);
    expect(reasons[onHold]).toEqual(['CAR_ON_HOLD']);
    expect(reasons[staffGone]).toEqual(['STAFF_INACTIVE']);
    expect(reasons[fine]).toBeUndefined();
  });

  test('a closed appointment never carries a flag', async () => {
    book({ status: 'CANCELLED', scheduledAt: LONG_AGO, slotSeat: undefined });
    expect((await list({ needsAttention: true })).items).toEqual([]);
  });
});
