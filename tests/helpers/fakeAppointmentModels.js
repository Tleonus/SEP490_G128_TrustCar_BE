/**
 * @file fakeAppointmentModels.js
 * @description In-memory stand-ins for the models used by the test-drive booking
 * services (no MongoDB): Appointment (find/findOne/create/updateMany/findOneAndUpdate),
 * Car (find), Customer (find/findOne), User (find). The real Appointment schema
 * validates every stored row.
 *
 * Features beyond plain storage:
 * - `calls`: every query as `{ model, method, filter }` (assert query counts, NFR-01…03).
 * - `hook`: optional async function awaited before/after each Appointment call;
 *   tests use it to run a competing request at an exact moment (race tests).
 * - duplicate `appointmentCode` throws a Mongo-style E11000 error.
 *
 * Supported filters: equality, $in, $gt, $gte, $lt, $lte, $ne, $regex (+$options), $or
 * (ObjectId/Date aware).
 * Query chain: select (top-level names), sort, skip, limit, lean, populate (ignored).
 *
 * Usage: import AFTER setupAuthHarness() when the HTTP app is involved.
 *   const fakes = await setupAppointmentFakes();   beforeEach(() => fakes.reset());
 */

import mongoose from 'mongoose';
import { FakeQuery, matches, clone } from './fakeAppointmentQuery.js';

const { ObjectId } = mongoose.Types;

/** Installs the fakes on the real model classes. */
export const setupAppointmentFakes = async () => {
  const { jest } = await import('@jest/globals');
  const { default: Appointment } = await import('../../src/models/Appointment.js');
  const { default: Car } = await import('../../src/models/Car.js');
  const { default: Customer } = await import('../../src/models/Customer.js');
  const { default: User } = await import('../../src/models/User.js');

  const state = { appointments: [], cars: [], customers: [], users: [], calls: [], hook: null, now: () => new Date() };

  // E-mail: every test that uses these fakes gets a recording sender, so the real provider
  // can never be reached. `mail.fail` / `mail.delayMs` simulate a broken or slow provider.
  const mailService = await import('../../src/services/appointmentMailService.js');
  const mail = { sent: [], fail: false, delayMs: 0 };
  mailService.setMailSender(async (message) => {
    if (mail.delayMs) await new Promise((resolve) => { setTimeout(resolve, mail.delayMs); });
    if (mail.fail) throw new Error('SMTP unavailable (simulated)');
    mail.sent.push(message);
  });

  const record = async (model, method, filter, phase = 'before') => {
    if (phase === 'before') state.calls.push({ model, method, filter });
    if (state.hook) await state.hook({ model, method, filter, phase });
  };
  // `findOne(filter, projection, { sort })` is the 3-argument form used by generateAppointmentCode.
  const findQuery = (model, list, method, single) => (filter = {}, _projection, options) => {
    const query = new FakeQuery(async () => {
      await record(model, method, filter);
      const found = state[list].filter((doc) => matches(doc, filter));
      await record(model, method, filter, 'after');
      return found;
    }, single);
    return options?.sort ? query.sort(options.sort) : query;
  };

  jest.spyOn(Appointment, 'find').mockImplementation(findQuery('Appointment', 'appointments', 'find', false));
  jest.spyOn(Appointment, 'findOne').mockImplementation(findQuery('Appointment', 'appointments', 'findOne', true));
  jest.spyOn(Car, 'find').mockImplementation(findQuery('Car', 'cars', 'find', false));
  jest.spyOn(Customer, 'find').mockImplementation(findQuery('Customer', 'customers', 'find', false));
  jest.spyOn(Customer, 'findOne').mockImplementation(findQuery('Customer', 'customers', 'findOne', true));
  jest.spyOn(User, 'find').mockImplementation(findQuery('User', 'users', 'find', false));
  jest.spyOn(User, 'findOne').mockImplementation(findQuery('User', 'users', 'findOne', true));

  jest.spyOn(Appointment, 'create').mockImplementation(async (data) => {
    await record('Appointment', 'create', data);
    const doc = new Appointment(data);
    const error = doc.validateSync();
    if (error) throw error;
    if (state.appointments.some((row) => row.appointmentCode === doc.appointmentCode)) {
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern: { appointmentCode: 1 } });
    }
    const raw = doc.toObject();
    raw.createdAt = state.now();
    raw.updatedAt = raw.createdAt;
    state.appointments.push(raw);
    await record('Appointment', 'create', data, 'after');
    return clone(raw);
  });

  // `findOneAndUpdate(filter, update, { new: true })`: atomic compare-and-set of ONE row.
  // Returns the updated row, or null when nothing matched (the caller lost the race).
  jest.spyOn(Appointment, 'findOneAndUpdate').mockImplementation((filter, update) => new FakeQuery(async () => {
    await record('Appointment', 'findOneAndUpdate', filter);
    const hit = state.appointments.find((doc) => matches(doc, filter));
    if (hit) Object.assign(hit, update.$set ?? {}, { updatedAt: state.now() });
    await record('Appointment', 'findOneAndUpdate', filter, 'after');
    return hit ? [hit] : [];
  }, true));

  jest.spyOn(Appointment, 'updateMany').mockImplementation(async (filter, update) => {
    await record('Appointment', 'updateMany', filter);
    const hit = state.appointments.filter((doc) => matches(doc, filter));
    hit.forEach((doc) => Object.assign(doc, update.$set ?? {}, { updatedAt: state.now() }));
    await record('Appointment', 'updateMany', filter, 'after');
    return { acknowledged: true, matchedCount: hit.length, modifiedCount: hit.length };
  });

  let seq = 0;
  const id = () => new ObjectId();
  const add = (list, doc) => { state[list].push(doc); return doc; };

  return {
    state,
    get appointments() { return state.appointments; },
    get calls() { return state.calls; },
    mail,
    /** Waits for every background e-mail dispatched so far, then returns what was "sent". */
    flushMail: async () => { await mailService.awaitPendingMail(); return mail.sent; },
    set hook(fn) { state.hook = fn; },
    set now(fn) { state.now = fn; },

    addCar: (extra = {}) => add('cars', {
      _id: id(), vehicleCode: `TC-2026-${String(++seq).padStart(4, '0')}`, make: 'MAZDA', model: 'CX-5', variant: '2.0',
      year: 2020, status: 'AVAILABLE', isActive: true,
      images: [{ url: 'https://img.example/a.jpg', publicId: 'secret-id', isPrimary: true }],
      internalNotes: 'secret', floorPrice: 1, originalPrice: 2, priceHistory: [{ price: 1 }], vin: 'VIN123', licensePlate: '51A-000.00',
      ...extra,
    }),
    addCustomer: (extra = {}) => add('customers', { _id: id(), fullName: 'Khách Test', phone: '0900000000', email: 'k@example.com', ...extra }),
    addUser: (extra = {}) => add('users', { _id: id(), fullName: 'Nhân viên Test', ...extra }),
    addAppointment: (extra = {}) => {
      const doc = new Appointment({
        appointmentCode: `APT-${String(1000 + ++seq)}`, type: 'TEST_DRIVE', durationMinutes: 90, createdBy: id(), ...extra,
      });
      const error = doc.validateSync();
      if (error) throw error;
      const raw = doc.toObject();
      raw.createdAt = extra.createdAt ?? state.now();
      raw.updatedAt = extra.updatedAt ?? raw.createdAt;
      return add('appointments', raw);
    },

    /** Number of recorded queries matching `{model, method}`. */
    count: (model, method) => state.calls.filter((c) => c.model === model && (!method || c.method === method)).length,
    reset() {
      ['appointments', 'cars', 'customers', 'users', 'calls'].forEach((k) => { state[k].length = 0; });
      state.hook = null;
      state.now = () => new Date();
      mail.sent.length = 0;
      mail.fail = false;
      mail.delayMs = 0;
    },
  };
};

export default setupAppointmentFakes;
