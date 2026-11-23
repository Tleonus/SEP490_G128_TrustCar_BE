/**
 * @file appointment-add-car.test.js
 * @description A customer adds cars to their own visit while it is still PENDING: same visit (id,
 * code, slot), at most 3 open cars, the usual car rules, no new seat and no e-mail. Every refusal
 * leaves the data exactly as it was.
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { addCarsToMyVisit } from '../src/services/appointmentAddCarService.js';
import { listMyVisits } from '../src/services/appointmentCustomerService.js';
import { default as ActivityLog } from '../src/models/ActivityLog.js';

const fakes = await setupAppointmentFakes();
const logSpy = jest.spyOn(ActivityLog, 'log').mockResolvedValue(undefined);

const NOW = new Date('2026-11-08T00:00:00Z');
const BOOKED = new Date('2026-11-07T09:00:00Z');
const SLOT = new Date('2026-11-12T03:00:00Z'); // Thu 10:00 VN
const OTHER = new Date('2026-11-13T06:00:00Z'); // Fri 13:00 VN
const userId = new mongoose.Types.ObjectId();
let me;
let rival;

beforeEach(() => {
  fakes.reset(); logSpy.mockClear();
  me = fakes.addCustomer({ fullName: 'Nguyễn An', email: 'an@example.com' });
  rival = fakes.addCustomer({ fullName: 'Khách Khác' });
});

const row = (who, scheduledAt, extra = {}) => fakes.addAppointment({
  customer: who._id, car: fakes.addCar()._id, scheduledAt, createdBy: userId, createdAt: BOOKED, holdsCar: true, ...extra,
});
const myVisit = (n = 1, extra = {}) => Array.from({ length: n }, (_, i) => row(me, SLOT, i === 0 ? { visitSeat: 1, ...extra } : extra));
const reject = (promise) => promise.then(() => null, (error) => error);
const snapshot = () => JSON.stringify(fakes.appointments);
const add = (carIds, extra = {}) => addCarsToMyVisit({
  customerId: me._id, userId, id: fakes.appointments[0]._id, carIds: carIds.map(String), now: NOW, ...extra,
});

describe('adding cars to a PENDING visit', () => {
  it('keeps the same visit: id, code, slot, and lists both cars', async () => {
    const [a] = myVisit(1);
    const car = fakes.addCar();
    const visit = await add([car._id]);

    expect(visit.visitId).toBe(String(a._id));
    expect(visit.visitCode).toBe(a.appointmentCode);
    expect(visit.status).toBe('PENDING');
    expect(visit.scheduledAt).toBe(SLOT.toISOString());
    expect(visit.appointments.map((x) => x.car._id).sort()).toEqual([String(a.car), String(car._id)].sort());

    const { visits } = await listMyVisits({ customerId: me._id, now: NOW });
    expect(visits).toHaveLength(1);
    expect(visits[0].appointments).toHaveLength(2);
  });

  it('the new row holds its car, takes no seat and shares the booking time', async () => {
    const [a] = myVisit(1, { notes: 'đường cao tốc' });
    const car = fakes.addCar();
    await add([car._id]);
    const added = fakes.appointments.find((r) => String(r.car) === String(car._id));
    expect(added).toMatchObject({ status: 'PENDING', holdsCar: true, isActive: true, notes: 'đường cao tốc', type: 'TEST_DRIVE' });
    expect(added.visitSeat ?? null).toBeNull();
    expect(new Date(added.createdAt)).toEqual(BOOKED);
    expect(added.scheduledAt).toEqual(SLOT);
    expect(String(added.createdBy)).toBe(String(a.createdBy));
  });

  it('adds two cars at once up to three', async () => {
    myVisit(1);
    const visit = await add([fakes.addCar()._id, fakes.addCar()._id]);
    expect(visit.appointments).toHaveLength(3);
  });

  it('is allowed even when the slot is full of other guests (the visit already has its seat)', async () => {
    myVisit(1);
    fakes.capacity = 2;
    row(rival, SLOT, { visitSeat: 2 });
    const visit = await add([fakes.addCar()._id]);
    expect(visit.appointments).toHaveLength(2);
  });

  it('logs one entry per new car and sends no e-mail', async () => {
    myVisit(1);
    await add([fakes.addCar()._id, fakes.addCar()._id]);
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(await fakes.flushMail()).toHaveLength(0);
  });
});

describe('refusals leave everything as it was', () => {
  const refused = async (carIds, code, extra) => {
    const before = snapshot();
    const error = await reject(add(carIds, extra));
    expect(error?.code).toBe(code);
    expect(snapshot()).toBe(before);
    return error;
  };

  it('a confirmed visit', async () => {
    myVisit(1, { status: 'CONFIRMED' });
    await refused([fakes.addCar()._id], 'APPOINTMENT_ADD_CAR_NOT_ALLOWED');
  });

  it('a cancelled visit', async () => {
    myVisit(1, { status: 'CANCELLED', holdsCar: undefined, visitSeat: undefined });
    await refused([fakes.addCar()._id], 'APPOINTMENT_ADD_CAR_NOT_ALLOWED');
  });

  it('more than three cars in total', async () => {
    myVisit(2);
    await refused([fakes.addCar()._id, fakes.addCar()._id], 'APPOINTMENT_CAR_LIMIT_REACHED');
  });

  it('a car already in the visit', async () => {
    const [a] = myVisit(1);
    const error = await refused([a.car], 'APPOINTMENT_DUPLICATE');
    expect(error.errors).toEqual({ carIds: [String(a.car)] });
  });

  it('a car the customer holds in another upcoming visit', async () => {
    myVisit(1);
    const other = row(me, OTHER);
    const error = await refused([other.car], 'APPOINTMENT_DUPLICATE');
    expect(error.errors).toEqual({ carIds: [String(other.car)] });
  });

  it('a car another customer holds at this slot', async () => {
    myVisit(1);
    const taken = row(rival, SLOT, { visitSeat: 2 });
    await refused([taken.car], 'APPOINTMENT_CONFLICT');
  });

  it('a car no longer for sale', async () => {
    myVisit(1);
    await refused([fakes.addCar({ status: 'SOLD' })._id], 'NOT_FOUND');
  });

  it('too close to the visit time', async () => {
    myVisit(1);
    await refused([fakes.addCar()._id], 'APPOINTMENT_TOO_SOON', { now: new Date(SLOT.getTime() - 30 * 60 * 1000) });
  });

  it("another customer's visit looks missing", async () => {
    row(rival, SLOT, { visitSeat: 1 });
    await refused([fakes.addCar()._id], 'APPOINTMENT_NOT_FOUND');
  });
});
