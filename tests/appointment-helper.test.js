/**
 * @file appointment-helper.test.js
 * @description Proves the in-memory model fakes and the read-query module behave like
 * the real thing where the booking services depend on it (filters, projection,
 * ordering, query counting, duplicate codes), plus the audit mapping.
 *
 * Ref: .sdd/features/test-drive-booking/PLAN.md (C-Q, C-AUDIT, section 8)
 */

import { jest } from '@jest/globals';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import {
  findOpenAtSlot, findCustomerOpen, findOpenInRange, findVisitRowsByAnyId, loadVisitContext, findBookableCars,
  findOpenFuture, findUnsellableCars, findCustomerContact, findHiddenReschedules, searchCustomers,
} from '../src/services/appointmentQueries.js';
import { logAppointmentEvent, logRescheduled } from '../src/services/appointmentAudit.js';
import { default as Appointment } from '../src/models/Appointment.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';

const fakes = await setupAppointmentFakes();
beforeEach(() => fakes.reset());

const SLOT = new Date('2026-11-10T03:00:00Z');
const LATER = new Date('2026-11-11T03:00:00Z');
const base = (customer, car, scheduledAt, extra = {}) =>
  fakes.addAppointment({ customer: customer._id, car: car._id, scheduledAt, ...extra });

describe('read queries', () => {
  it('findOpenAtSlot returns only open, visible rows of that exact slot, projected', async () => {
    const [c1, c2] = [fakes.addCustomer(), fakes.addCustomer()];
    const [a, b] = [fakes.addCar(), fakes.addCar()];
    base(c1, a, SLOT);
    base(c2, b, SLOT, { status: 'CANCELLED' });
    base(c2, b, SLOT, { isActive: false });
    base(c2, b, LATER);
    const rows = await findOpenAtSlot(SLOT);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(['_id', 'car', 'customer', 'isActive', 'scheduledAt', 'status']);
  });

  it('findCustomerOpen is limited to one customer and to the future', async () => {
    const [c1, c2] = [fakes.addCustomer(), fakes.addCustomer()];
    const car = fakes.addCar();
    base(c1, car, SLOT);
    base(c1, car, new Date('2026-11-01T03:00:00Z'));
    base(c2, car, LATER);
    const rows = await findCustomerOpen(c1._id, new Date('2026-11-05T00:00:00Z'));
    expect(rows).toHaveLength(1);
    expect(String(rows[0].customer)).toBe(String(c1._id));
  });

  it('findOpenInRange uses [from, to) and exactly one query', async () => {
    const c = fakes.addCustomer();
    const car = fakes.addCar();
    base(c, car, SLOT);
    base(c, car, LATER);
    const before = fakes.count('Appointment');
    const rows = await findOpenInRange(SLOT, LATER);
    expect(rows).toHaveLength(1);
    expect(fakes.count('Appointment') - before).toBe(1);
  });

  it('findVisitRowsByAnyId returns the whole visit, honours the owner filter and hides inactive rows', async () => {
    const [c1, c2] = [fakes.addCustomer(), fakes.addCustomer()];
    const [a, b, d] = [fakes.addCar(), fakes.addCar(), fakes.addCar()];
    const first = base(c1, a, SLOT);
    base(c1, b, SLOT);
    base(c1, d, SLOT, { isActive: false });
    base(c2, a, LATER);
    expect(await findVisitRowsByAnyId(first._id)).toHaveLength(2);
    expect(await findVisitRowsByAnyId(first._id, { customerId: c1._id })).toHaveLength(2);
    expect(await findVisitRowsByAnyId(first._id, { customerId: c2._id })).toEqual([]);
    expect(await findVisitRowsByAnyId(new (await import('mongoose')).default.Types.ObjectId())).toEqual([]);
  });

  it('loadVisitContext issues one query per related collection, not per row', async () => {
    const c = fakes.addCustomer();
    const staff = fakes.addUser();
    const cars = [fakes.addCar(), fakes.addCar(), fakes.addCar()];
    const rows = cars.map((car) => base(c, car, SLOT, { assignedTo: staff._id }));
    fakes.calls.length = 0;
    const ctx = await loadVisitContext([{ customer: c._id, rows }], { staff: true });
    expect(ctx.carsById.size).toBe(3);
    expect(ctx.customersById.get(String(c._id)).phone).toBe('0900000000');
    expect(ctx.usersById.get(String(staff._id)).fullName).toBe('Nhân viên Test');
    expect(fakes.count('Car')).toBe(1);
    expect(fakes.count('Customer')).toBe(1);
    expect(fakes.count('User')).toBe(1);
  });

  it('findBookableCars skips cars that are not AVAILABLE or not active', async () => {
    const ok = fakes.addCar();
    const sold = fakes.addCar({ status: 'SOLD' });
    const gone = fakes.addCar({ isActive: false });
    const found = await findBookableCars([ok._id, sold._id, gone._id]);
    expect(found.map((car) => String(car._id))).toEqual([String(ok._id)]);
  });
});

describe('fake Appointment model', () => {
  it('validates with the real schema, assigns timestamps and rejects duplicate codes with E11000', async () => {
    const c = fakes.addCustomer();
    const car = fakes.addCar();
    const data = { appointmentCode: 'APT-0001', customer: c._id, car: car._id, type: 'TEST_DRIVE', scheduledAt: SLOT, createdBy: c._id };
    const saved = await Appointment.create(data);
    expect(saved.status).toBe('PENDING');
    expect(saved.createdAt).toBeInstanceOf(Date);
    await expect(Appointment.create(data)).rejects.toMatchObject({ code: 11000 });
    await expect(Appointment.create({ ...data, appointmentCode: 'APT-0002', type: 'BOGUS' })).rejects.toThrow();
  });

  it('updateMany applies $set to matching rows only and sorts / paginates queries', async () => {
    const c = fakes.addCustomer();
    const car = fakes.addCar();
    const one = base(c, car, SLOT);
    const two = base(c, car, LATER);
    const res = await Appointment.updateMany({ _id: { $in: [one._id] } }, { $set: { status: 'CANCELLED' } });
    expect(res.modifiedCount).toBe(1);
    expect(fakes.appointments.find((r) => String(r._id) === String(one._id)).status).toBe('CANCELLED');
    expect(fakes.appointments.find((r) => String(r._id) === String(two._id)).status).toBe('PENDING');
    const sorted = await Appointment.find({}).sort({ scheduledAt: -1 }).limit(1).lean();
    expect(String(sorted[0]._id)).toBe(String(two._id));
  });

  it('runs the hook before and after a call so tests can interleave requests', async () => {
    const seen = [];
    fakes.hook = async ({ method, phase }) => { seen.push(`${method}:${phase}`); };
    await Appointment.find({});
    expect(seen).toEqual(['find:before', 'find:after']);
  });
});

describe('logAppointmentEvent', () => {
  it('maps every status to its ActivityEventType and records the transition', async () => {
    const spy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);
    const appointment = { _id: 'id1', appointmentCode: 'APT-0001' };
    const expected = {
      PENDING: 'APPOINTMENT_CREATED', CONFIRMED: 'APPOINTMENT_CONFIRMED', CANCELLED: 'APPOINTMENT_CANCELLED',
      COMPLETED: 'APPOINTMENT_COMPLETED', NO_SHOW: 'APPOINTMENT_NO_SHOW',
    };
    for (const [status, eventType] of Object.entries(expected)) {
      await logAppointmentEvent({ appointment, status, from: status === 'PENDING' ? undefined : 'PENDING', userId: 'u1' });
      expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({
        eventType, targetModel: 'Appointment', targetId: 'id1', targetCode: 'APT-0001', performedBy: 'u1',
      }));
    }
    spy.mockRestore();
  });
});

// ── 1.1.0 additions ──────────────────────────────────────────────────────────

describe('fake model capabilities added in 1.1.0', () => {
  it('findOneAndUpdate is a compare-and-set of ONE row: the second caller gets null', async () => {
    const row = base(fakes.addCustomer(), fakes.addCar(), SLOT);
    const cas = () => Appointment.findOneAndUpdate(
      { _id: row._id, status: { $in: ['PENDING', 'CONFIRMED'] }, isActive: true },
      { $set: { status: 'CANCELLED' } }, { new: true },
    ).lean();
    expect((await cas()).status).toBe('CANCELLED');
    expect(await cas()).toBeNull();
    expect(fakes.count('Appointment', 'findOneAndUpdate')).toBe(2);
  });

  it('supports $or and case-insensitive $regex', async () => {
    fakes.addCustomer({ fullName: 'Nguyễn Văn An', phone: '0901', email: 'an@example.com' });
    fakes.addCustomer({ fullName: 'Trần Bình', phone: '0902', email: 'binh@example.com' });
    const { default: Customer } = await import('../src/models/Customer.js');
    const like = { $regex: 'AN@', $options: 'i' };
    const found = await Customer.find({ $or: [{ fullName: like }, { email: like }] }).lean();
    expect(found.map((c) => c.fullName)).toEqual(['Nguyễn Văn An']);
  });
});

describe('queries added in 1.1.0', () => {
  it('findOpenFuture returns open rows after `now` only', async () => {
    const [c, car] = [fakes.addCustomer(), fakes.addCar()];
    base(c, car, SLOT);
    base(c, car, new Date('2026-11-01T03:00:00Z'));
    base(c, car, LATER, { status: 'CANCELLED' });
    const rows = await findOpenFuture(new Date('2026-11-05T00:00:00Z'));
    expect(rows.map((r) => r.scheduledAt.getTime())).toEqual([SLOT.getTime()]);
  });

  it('findUnsellableCars returns cars that are not AVAILABLE or are inactive', async () => {
    const ok = fakes.addCar();
    const sold = fakes.addCar({ status: 'SOLD' });
    const hidden = fakes.addCar({ isActive: false });
    const rows = await findUnsellableCars([ok._id, sold._id, hidden._id].map(String));
    expect(rows.map((r) => String(r._id)).sort()).toEqual([sold._id, hidden._id].map(String).sort());
  });

  it('findCustomerContact reads name and e-mail only', async () => {
    const c = fakes.addCustomer({ fullName: 'An', email: 'an@example.com' });
    expect(await findCustomerContact(c._id)).toEqual({ _id: c._id, fullName: 'An', email: 'an@example.com' });
    expect(await findCustomerContact(new Appointment()._id)).toBeNull();
  });

  it('findHiddenReschedules matches hidden rows of the given customers by exact reason', async () => {
    const [a, b] = [fakes.addCustomer(), fakes.addCustomer()];
    const car = fakes.addCar();
    base(a, car, SLOT, { isActive: false, status: 'CANCELLED', cancellationReason: 'RESCHEDULED:APT-0007' });
    base(a, car, SLOT, { isActive: false, status: 'CANCELLED', cancellationReason: 'RACE_LOST' });
    base(b, car, SLOT, { isActive: false, status: 'CANCELLED', cancellationReason: 'RESCHEDULED:APT-0007' });
    base(a, car, SLOT, { status: 'CANCELLED', cancellationReason: 'RESCHEDULED:APT-0007' }); // visible: not a reschedule leftover
    const rows = await findHiddenReschedules({ customerIds: [a._id], reasons: ['RESCHEDULED:APT-0007'] });
    expect(rows).toHaveLength(1);
    expect(String(rows[0].customer)).toBe(String(a._id));
  });

  it('searchCustomers matches name/phone/e-mail, escapes the pattern, and only returns customers with an active account', async () => {
    const withAccount = fakes.addCustomer({ fullName: 'Lê Văn Cường', phone: '0933000111', email: 'cuong@example.com' });
    const inactive = fakes.addCustomer({ fullName: 'Lê Thị Cúc', phone: '0933000222' });
    fakes.addCustomer({ fullName: 'Lê Không Tài Khoản', phone: '0933000333' });
    fakes.addUser({ customer: withAccount._id, roleName: 'CUSTOMER', isActive: true });
    fakes.addUser({ customer: inactive._id, roleName: 'CUSTOMER', isActive: false });
    const found = await searchCustomers('0933', 10);
    expect(found.map((c) => c.fullName)).toEqual(['Lê Văn Cường']);
    expect(Object.keys(found[0]).sort()).toEqual(['_id', 'email', 'fullName', 'phone']);
    expect(await searchCustomers('.*', 10)).toEqual([]); // the pattern is escaped, not interpreted
    expect(await searchCustomers('CUONG@', 10)).toHaveLength(1);
    expect(await searchCustomers('Lê', 0)).toEqual([]);
  });
});

describe('logRescheduled', () => {
  it('writes exactly one APPOINTMENT_RESCHEDULED entry for the new visit and never throws', async () => {
    const spy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);
    const call = { newRows: [{ _id: 'n1' }], previousCode: 'APT-0001', newCode: 'APT-0009', fromAt: SLOT, toAt: LATER, userId: 'u1', ipAddress: '::1' };
    await logRescheduled(call);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'APPOINTMENT_RESCHEDULED', performedBy: 'u1', targetModel: 'Appointment', targetId: 'n1', targetCode: 'APT-0009',
      metadata: { previousVisitCode: 'APT-0001' },
      changes: { before: { scheduledAt: SLOT }, after: { scheduledAt: LATER } },
    }));
    spy.mockRejectedValueOnce(new Error('db down'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(logRescheduled(call)).resolves.toBeUndefined();
    quiet.mockRestore();
    spy.mockRestore();
  });
});
