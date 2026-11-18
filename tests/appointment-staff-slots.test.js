/**
 * @file appointment-staff-slots.test.js
 * @description The slot grid for staff (who booked, places left, no 2-hour lead time) and the
 * customer grid's `excludeVisitId` (the slots as they would look after a visit moved).
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-035, REQ-036, NFR-09; AC-34, AC-39)
 */

import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { getStaffSlots } from '../src/services/appointmentStaffSlotService.js';
import { getSlots } from '../src/services/appointmentSlotService.js';

const fakes = await setupAppointmentFakes();
beforeEach(() => fakes.reset());

const NOW = new Date('2026-11-08T00:00:00Z'); // Sunday 07:00 VN
const TEN = '2026-11-10T03:00:00Z'; // Tuesday 10:00 VN
const ONE_PM = '2026-11-10T06:00:00Z';
const reject = (promise) => promise.then(() => null, (error) => error);
const slotAt = (result, date, hhmm) => result.days.find((d) => d.date === date).slots.find((s) => s.start.includes(`T${hhmm}:`));
const staff = (extra = {}) => getStaffSlots({ from: '2026-11-08', to: '2026-11-10', now: NOW, ...extra });
const put = (who, car, iso, extra = {}) =>
  fakes.addAppointment({ customer: who._id, car: car._id, scheduledAt: new Date(iso), ...extra });

describe('staff grid (REQ-035, AC-34)', () => {
  it('lists the four slots of every day with the places left and an empty visit list', async () => {
    const result = await staff();
    expect(result.days.map((d) => d.date)).toEqual(['2026-11-08', '2026-11-09', '2026-11-10']);
    expect(slotAt(result, '2026-11-10', '10:00')).toEqual({
      start: '2026-11-10T10:00:00+07:00', available: true, capacityRemaining: 2, reason: null, visits: [],
    });
  });

  it('shows WHO is booked: visit code, status, customer name and phone, cars', async () => {
    const an = fakes.addCustomer({ fullName: 'Nguyễn An', phone: '0901000111' });
    const car = fakes.addCar({ make: 'MAZDA', model: 'CX-5' });
    put(an, car, TEN, { appointmentCode: 'APT-0042', status: 'CONFIRMED' });
    const slot = slotAt(await staff(), '2026-11-10', '10:00');
    expect(slot).toMatchObject({ available: true, capacityRemaining: 1, reason: null });
    expect(slot.visits).toEqual([{
      visitId: expect.any(String), visitCode: 'APT-0042', status: 'CONFIRMED',
      customer: { _id: String(an._id), fullName: 'Nguyễn An', phone: '0901000111' },
      cars: [{ _id: String(car._id), vehicleCode: car.vehicleCode, make: 'MAZDA', model: 'CX-5' }],
    }]);
    expect(JSON.stringify(slot)).not.toMatch(/email|secret|VIN123|51A-000|internalNotes|floorPrice|publicId/);
  });

  it('groups the cars of one customer into one visit; two customers fill the slot (CAPACITY_FULL)', async () => {
    const [an, binh] = [fakes.addCustomer({ fullName: 'An' }), fakes.addCustomer({ fullName: 'Bình' })];
    put(an, fakes.addCar(), ONE_PM); put(an, fakes.addCar(), ONE_PM);
    put(binh, fakes.addCar(), ONE_PM);
    const slot = slotAt(await staff(), '2026-11-10', '13:00');
    expect(slot).toMatchObject({ available: false, reason: 'CAPACITY_FULL', capacityRemaining: 0 });
    expect(slot.visits.map((v) => v.cars.length).sort()).toEqual([1, 2]);
  });

  it('with cars given, a held car is CAR_BOOKED naming it, even while places remain', async () => {
    const car = fakes.addCar(); const free = fakes.addCar();
    put(fakes.addCustomer(), car, TEN);
    const slot = slotAt(await staff({ carIds: [String(car._id), String(free._id)] }), '2026-11-10', '10:00');
    expect(slot).toMatchObject({ available: false, reason: 'CAR_BOOKED', carIds: [String(car._id)], capacityRemaining: 1 });
  });

  it('ignores cancelled, finished and hidden rows', async () => {
    const who = fakes.addCustomer();
    put(who, fakes.addCar(), TEN, { status: 'CANCELLED' });
    put(who, fakes.addCar(), TEN, { status: 'COMPLETED' });
    put(who, fakes.addCar(), TEN, { isActive: false });
    expect(slotAt(await staff(), '2026-11-10', '10:00')).toMatchObject({ available: true, capacityRemaining: 2, visits: [] });
  });

  it('has no 2-hour lead time: a slot only becomes PAST once it has started', async () => {
    const now = new Date('2026-11-08T02:00:00Z'); // 09:00 VN
    const result = await staff({ now });
    expect(slotAt(result, '2026-11-08', '08:00')).toMatchObject({ available: false, reason: 'PAST' });
    expect(slotAt(result, '2026-11-08', '10:00')).toMatchObject({ available: true, reason: null }); // 1 h away: a customer could not book it
  });

  it('is limited like the customer grid: at most 14 days, within 60 days, valid dates (422)', async () => {
    expect((await reject(staff({ to: '2026-11-30' }))).code).toBe('VALIDATION_ERROR');
    await expect(staff({ from: '2026-12-01', to: '2026-12-02' })).resolves.toBeDefined(); // 23 days ahead: fine
    expect((await reject(staff({ from: '2027-03-01', to: '2027-03-02' }))).code).toBe('VALIDATION_ERROR');
    expect((await reject(staff({ from: '2026-11-07', to: '2026-11-08' }))).code).toBe('VALIDATION_ERROR');
    expect((await reject(staff({ from: 'nope' }))).code).toBe('VALIDATION_ERROR');
  });

  it('reads: 1 appointment query + at most 1 customer + 1 car query (NFR-09)', async () => {
    put(fakes.addCustomer(), fakes.addCar(), TEN); put(fakes.addCustomer(), fakes.addCar(), ONE_PM);
    const before = fakes.calls.length;
    await staff();
    const used = fakes.calls.slice(before);
    expect(used.filter((c) => c.model === 'Appointment')).toHaveLength(1);
    expect(used.filter((c) => c.model === 'Customer').length).toBeLessThanOrEqual(1);
    expect(used.filter((c) => c.model === 'Car').length).toBeLessThanOrEqual(1);
    expect(used.filter((c) => c.model === 'User')).toHaveLength(0); // no staff ids in the light rows → no lookup
    expect(used).toHaveLength(3);
  });

  it('excludeVisitId removes that visit from every figure and costs two more reads; an unknown id is 404', async () => {
    const an = fakes.addCustomer();
    const a = put(an, fakes.addCar(), TEN); put(an, fakes.addCar(), TEN);
    put(fakes.addCustomer(), fakes.addCar(), TEN);
    const moving = await staff({ excludeVisitId: a._id });
    expect(slotAt(moving, '2026-11-10', '10:00')).toMatchObject({ capacityRemaining: 1 });
    expect(slotAt(moving, '2026-11-10', '10:00').visits).toHaveLength(1);
    expect(slotAt(await staff(), '2026-11-10', '10:00')).toMatchObject({ capacityRemaining: 0, reason: 'CAPACITY_FULL' });
    expect((await reject(staff({ excludeVisitId: new mongoose.Types.ObjectId() }))).code).toBe('APPOINTMENT_NOT_FOUND');
  });
});

describe("customer grid: excludeVisitId (REQ-036)", () => {
  const run = (extra = {}) => getSlots({
    customerId: me._id, carIds: [String(new mongoose.Types.ObjectId())], from: '2026-11-09', to: '2026-11-10', now: NOW, ...extra,
  });
  let me;
  beforeEach(() => { me = fakes.addCustomer(); });

  it("ignores the customer's own visit, so its car and its slot are free again", async () => {
    const car = fakes.addCar();
    const own = put(me, car, TEN);
    const without = await run({ carIds: [String(car._id)] });
    expect(slotAt(without, '2026-11-10', '10:00')).toMatchObject({ available: false, reason: 'ALREADY_BOOKED' });
    const moving = await run({ carIds: [String(car._id)], excludeVisitId: own._id });
    expect(slotAt(moving, '2026-11-10', '10:00')).toEqual({ start: '2026-11-10T10:00:00+07:00', available: true });
  });

  it('another visit of the same customer still counts; other customers always count', async () => {
    const own = put(me, fakes.addCar(), TEN);
    put(me, fakes.addCar(), ONE_PM);
    put(fakes.addCustomer(), fakes.addCar(), ONE_PM); put(fakes.addCustomer(), fakes.addCar(), ONE_PM);
    const moving = await run({ excludeVisitId: own._id });
    expect(slotAt(moving, '2026-11-10', '13:00')).toMatchObject({ available: false });
  });

  it("someone else's visit or an unknown id is 404, the same as a missing one; the customer never sees other people", async () => {
    const theirs = put(fakes.addCustomer(), fakes.addCar(), TEN);
    expect((await reject(run({ excludeVisitId: theirs._id }))).code).toBe('APPOINTMENT_NOT_FOUND');
    expect((await reject(run({ excludeVisitId: new mongoose.Types.ObjectId() }))).code).toBe('APPOINTMENT_NOT_FOUND');
    expect(JSON.stringify(await run())).not.toMatch(/visits|phone|fullName/);
  });
});
