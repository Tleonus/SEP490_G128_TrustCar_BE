/**
 * @file appointment-harness.test.js
 * @description The in-memory test harness itself: transactions (rollback, write conflict),
 * partial unique indexes, `$unset`, `new: false`, `$type`/`$exists`, `Customer.updateOne`,
 * and the settings capacity. Services are NOT involved here.
 */

import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { withTransaction } from '../src/utils/withTransaction.js';
import { getSlotCapacity } from '../src/services/appointmentCapacity.js';

const { default: Appointment } = await import('../src/models/Appointment.js');
const { default: Customer } = await import('../src/models/Customer.js');
const fakes = await setupAppointmentFakes();
beforeEach(() => fakes.reset());

const SLOT = new Date('2030-01-01T03:00:00Z');
const row = (extra = {}) => ({
  customer: new mongoose.Types.ObjectId(), car: new mongoose.Types.ObjectId(), type: 'TEST_DRIVE', scheduledAt: SLOT,
  createdBy: new mongoose.Types.ObjectId(), ...extra,
});
let code = 0;
const create = (extra = {}, options) => Appointment.create({ ...row(extra), appointmentCode: `APT-${String(5000 + ++code)}` }, options);

describe('transactions', () => {
  test('a committed transaction keeps its writes', async () => {
    await withTransaction(async (session) => { await create({}, { session }); });
    expect(fakes.appointments).toHaveLength(1);
    expect(fakes.openTransactions).toBe(0);
  });

  test('an aborted transaction undoes inserts and updates, and leaves other writes alone', async () => {
    const existing = fakes.addAppointment({ ...row(), status: 'PENDING' });
    await expect(withTransaction(async (session) => {
      await create({}, { session });
      await Appointment.updateMany({ _id: existing._id }, { $set: { status: 'CANCELLED' } }, { session });
      await create({}); // no session: not part of the transaction
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(fakes.appointments).toHaveLength(2); // existing + the write that had no session
    expect(fakes.appointments.find((x) => x._id === existing._id).status).toBe('PENDING');
    expect(fakes.openTransactions).toBe(0);
  });

  test('array create is all-or-nothing inside a transaction when an index refuses one row', async () => {
    fakes.enableIndexes('car');
    const car = new mongoose.Types.ObjectId();
    const rows = [
      { ...row({ car, holdsCar: true }), appointmentCode: 'APT-7001' },
      { ...row({ car, holdsCar: true }), appointmentCode: 'APT-7002' }, // same car+time: clashes
    ];
    await expect(withTransaction(async (session) => { await Appointment.create(rows, { session }); }))
      .rejects.toMatchObject({ code: 11000, keyPattern: { car: 1, scheduledAt: 1 } });
    expect(fakes.appointments).toHaveLength(0);
  });

  test('two active transactions writing the same document: the second gets a TransientTransactionError', async () => {
    const customer = fakes.addCustomer();
    const first = await mongoose.startSession();
    const second = await mongoose.startSession();
    first.startTransaction();
    second.startTransaction();
    await Customer.updateOne({ _id: customer._id }, { $set: { touched: 1 } }, { session: first });
    const error = await Customer.updateOne({ _id: customer._id }, { $set: { touched: 2 } }, { session: second }).catch((e) => e);
    expect(error.code).toBe(112);
    expect(error.hasErrorLabel('TransientTransactionError')).toBe(true);
    await first.commitTransaction();
    // once the first committed, the lock is free
    await expect(Customer.updateOne({ _id: customer._id }, { $set: { touched: 4 } }, { session: second })).resolves.toMatchObject({ matchedCount: 1 });
    await second.abortTransaction();
    expect(fakes.state.customers[0].touched).toBe(1); // the second's undo restored the committed value
  });

  test('Customer.updateOne reports matchedCount 0 for an unknown customer', async () => {
    const result = await Customer.updateOne({ _id: new mongoose.Types.ObjectId() }, { $set: { x: 1 } });
    expect(result.matchedCount).toBe(0);
  });
});

describe('partial unique indexes', () => {
  test('are off by default', async () => {
    const car = new mongoose.Types.ObjectId();
    await create({ car, holdsCar: true });
    await expect(create({ car, holdsCar: true })).resolves.toBeDefined();
  });

  test('car index: a second open row of the same car and time is refused with the car keyPattern', async () => {
    fakes.enableIndexes('car');
    const car = new mongoose.Types.ObjectId();
    await create({ car, holdsCar: true });
    await expect(create({ car, holdsCar: true })).rejects.toMatchObject({ code: 11000, keyPattern: { car: 1, scheduledAt: 1 } });
    await create({ car: new mongoose.Types.ObjectId(), holdsCar: true }); // another car: fine
    await create({ car, holdsCar: true, scheduledAt: new Date('2030-01-01T06:00:00Z') }); // another time: fine
    await create({ car }); // not holding (no holdsCar): the partial filter skips it
  });

  test('seat index: the same seat at the same time is refused with the seat keyPattern', async () => {
    fakes.enableIndexes('seat');
    await create({ visitSeat: 1 });
    await expect(create({ visitSeat: 1 })).rejects.toMatchObject({ code: 11000, keyPattern: { scheduledAt: 1, visitSeat: 1 } });
    await create({ visitSeat: 2 });
    await create({}); // no seat: not indexed
  });

  test('an update that creates a clash is refused and leaves the row unchanged', async () => {
    fakes.enableIndexes('seat');
    await create({ visitSeat: 1 });
    const second = await create({});
    await expect(Appointment.updateOne({ _id: second._id }, { $set: { visitSeat: 1 } })).rejects.toMatchObject({ code: 11000 });
    expect(fakes.appointments.find((x) => String(x._id) === String(second._id)).visitSeat).toBeUndefined();
  });

  test('appointmentCode is always unique', async () => {
    await Appointment.create({ ...row(), appointmentCode: 'APT-8000' });
    await expect(Appointment.create({ ...row(), appointmentCode: 'APT-8000' })).rejects.toMatchObject({ code: 11000, keyPattern: { appointmentCode: 1 } });
  });
});

describe('update operators and filters', () => {
  test('$unset removes fields, $set applies, and new:false returns the row as it was', async () => {
    const stored = fakes.addAppointment({ ...row({ holdsCar: true, visitSeat: 2 }), status: 'PENDING' });
    const before = await Appointment.findOneAndUpdate(
      { _id: stored._id, status: 'PENDING' },
      { $set: { status: 'CANCELLED' }, $unset: { holdsCar: 1, visitSeat: 1 } },
      { new: false },
    ).lean();
    expect(before).toMatchObject({ status: 'PENDING', holdsCar: true, visitSeat: 2 });
    const now = fakes.appointments.find((x) => x._id === stored._id);
    expect(now.status).toBe('CANCELLED');
    expect(now).not.toHaveProperty('holdsCar');
    expect(now).not.toHaveProperty('visitSeat');
  });

  test('$unset through updateMany and updateOne', async () => {
    const a = fakes.addAppointment({ ...row({ holdsCar: true }) });
    const b = fakes.addAppointment({ ...row({ holdsCar: true, visitSeat: 1 }) });
    await Appointment.updateMany({ _id: { $in: [a._id] } }, { $unset: { holdsCar: 1 } });
    await Appointment.updateOne({ _id: b._id }, { $unset: { visitSeat: 1 } });
    expect(a).not.toHaveProperty('holdsCar');
    expect(b).not.toHaveProperty('visitSeat');
    expect(b.holdsCar).toBe(true);
  });

  test('$type number and $exists select rows', async () => {
    fakes.addAppointment({ ...row({ visitSeat: 1 }) });
    fakes.addAppointment({ ...row() });
    expect(await Appointment.find({ visitSeat: { $type: 'number' } })).toHaveLength(1);
    expect(await Appointment.find({ visitSeat: { $exists: false } })).toHaveLength(1);
    expect(await Appointment.find({ visitSeat: { $exists: true } })).toHaveLength(1);
  });

  test('.session() is accepted on queries', async () => {
    fakes.addAppointment({ ...row() });
    expect(await Appointment.find({}).session({}).lean()).toHaveLength(1);
  });
});

describe('settings', () => {
  test('capacity defaults to the old fixed 2 and can be set per test', async () => {
    expect(await getSlotCapacity()).toBe(2);
    fakes.capacity = 3;
    expect(await getSlotCapacity()).toBe(3);
    fakes.reset();
    expect(await getSlotCapacity()).toBe(2);
  });
});

describe('allowDuplicateCodes', () => {
  test('lets two rows share an appointment code until reset', async () => {
    fakes.allowDuplicateCodes();
    await Appointment.create({ ...row(), appointmentCode: 'APT-8100' });
    await expect(Appointment.create({ ...row(), appointmentCode: 'APT-8100' })).resolves.toBeDefined();
    fakes.reset();
    await Appointment.create({ ...row(), appointmentCode: 'APT-8100' });
    await expect(Appointment.create({ ...row(), appointmentCode: 'APT-8100' })).rejects.toMatchObject({ code: 11000 });
  });
});
