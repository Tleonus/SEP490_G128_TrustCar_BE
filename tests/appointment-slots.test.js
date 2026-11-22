/**
 * @file appointment-slots.test.js
 * @description getSlots: per-day/per-slot availability with reasons, one read query,
 * range validation.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-013, NFR-03; AC-13)
 */

import mongoose from 'mongoose';
import { setupAppointmentFakes } from './helpers/fakeAppointmentModels.js';
import { getSlots } from '../src/services/appointmentSlotService.js';

const fakes = await setupAppointmentFakes();
beforeEach(() => fakes.reset());

const NOW = new Date('2026-11-08T00:00:00Z'); // 07:00 VN, Sunday 8 Nov
const at = (iso) => new Date(iso);
const run = (extra = {}) => getSlots({
  customerId: new mongoose.Types.ObjectId(), carIds: [String(new mongoose.Types.ObjectId())],
  from: '2026-11-08', to: '2026-11-10', now: NOW, ...extra,
});
const reject = (promise) => promise.then(() => null, (error) => error);
const slotAt = (result, date, hhmm) => result.days.find((d) => d.date === date).slots.find((s) => s.start.includes(`T${hhmm}:`));

describe('availability (AC-13)', () => {
  it('returns every day of the range with the four slots in Vietnam time', async () => {
    const result = await run();
    expect(result.days.map((d) => d.date)).toEqual(['2026-11-08', '2026-11-09', '2026-11-10']);
    expect(result.days[0].slots.map((s) => s.start)).toEqual([
      '2026-11-08T08:00:00+07:00', '2026-11-08T10:00:00+07:00', '2026-11-08T13:00:00+07:00', '2026-11-08T15:00:00+07:00',
    ]);
  });

  it('marks TOO_SOON inside the 2-hour margin and offers later slots the same day', async () => {
    const result = await run(); // now = 07:00 VN: 08:00 is 1h away, 10:00 is 3h away
    expect(slotAt(result, '2026-11-08', '08:00')).toEqual({ start: '2026-11-08T08:00:00+07:00', available: false, reason: 'TOO_SOON' });
    expect(slotAt(result, '2026-11-08', '10:00')).toEqual({ start: '2026-11-08T10:00:00+07:00', available: true });
  });

  it('reports CAR_BOOKED with the busy cars, ALREADY_BOOKED and CAPACITY_FULL', async () => {
    const me = fakes.addCustomer();
    const [x, y, free] = [fakes.addCar(), fakes.addCar(), fakes.addCar()];
    const put = (who, car, iso) => fakes.addAppointment({ customer: who._id, car: car._id, scheduledAt: at(iso) });
    put(fakes.addCustomer(), x, '2026-11-10T03:00:00Z'); // 10:00 on the 10th: X held by someone else
    put(me, y, '2026-11-09T01:00:00Z'); // 08:00 on the 9th: I already hold this slot
    put(fakes.addCustomer(), fakes.addCar(), '2026-11-10T06:00:00Z'); // 13:00 on the 10th: two others
    put(fakes.addCustomer(), fakes.addCar(), '2026-11-10T06:00:00Z');

    const result = await run({ customerId: me._id, carIds: [String(x._id), String(free._id)] });
    expect(slotAt(result, '2026-11-10', '10:00')).toMatchObject({ available: false, reason: 'CAR_BOOKED', carIds: [String(x._id)] });
    expect(slotAt(result, '2026-11-09', '08:00')).toMatchObject({ available: false, reason: 'ALREADY_BOOKED' });
    expect(slotAt(result, '2026-11-10', '13:00')).toMatchObject({ available: false, reason: 'CAPACITY_FULL' });
    expect(slotAt(result, '2026-11-10', '15:00')).toMatchObject({ available: true });
  });

  it('ignores closed and hidden appointments', async () => {
    const car = fakes.addCar();
    ['CANCELLED', 'COMPLETED', 'NO_SHOW'].forEach((status) =>
      fakes.addAppointment({ customer: fakes.addCustomer()._id, car: car._id, scheduledAt: at('2026-11-10T03:00:00Z'), status }));
    fakes.addAppointment({ customer: fakes.addCustomer()._id, car: car._id, scheduledAt: at('2026-11-10T03:00:00Z'), isActive: false });
    expect(slotAt(await run({ carIds: [String(car._id)] }), '2026-11-10', '10:00').available).toBe(true);
  });

  it('marks TOO_FAR beyond 60 days', async () => {
    const result = await run({ from: '2027-01-07', to: '2027-01-07' });
    expect(result.days[0].slots.every((s) => s.reason === 'TOO_FAR')).toBe(true);
  });

  it('reads the appointments of the whole range with exactly one query (NFR-03)', async () => {
    await run({ from: '2026-11-08', to: '2026-11-21' });
    expect(fakes.count('Appointment')).toBe(1);
    expect(fakes.count('Car')).toBe(0);
  });
});

describe('range validation (AC-13)', () => {
  it.each([
    ['more than 14 days', { from: '2026-11-08', to: '2026-11-22' }],
    ['a date in the past', { from: '2026-11-07', to: '2026-11-08' }],
    ['beyond 60 days', { from: '2027-01-07', to: '2027-01-08' }],
    ['to before from', { from: '2026-11-10', to: '2026-11-09' }],
    ['a malformed date', { from: '10-11-2026', to: '2026-11-12' }],
    ['an impossible date', { from: '2026-02-30', to: '2026-03-01' }],
  ])('rejects %s with 422 VALIDATION_ERROR before reading anything', async (_name, extra) => {
    const error = await reject(run(extra));
    expect(error).toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
    expect(fakes.calls).toHaveLength(0);
  });

  it('accepts exactly 14 days and today', async () => {
    await expect(run({ from: '2026-11-08', to: '2026-11-21' })).resolves.toHaveProperty('days.length', 14);
  });

  it('needs a linked customer (404 CUSTOMER_NOT_FOUND)', async () => {
    expect((await reject(run({ customerId: null }))).code).toBe('CUSTOMER_NOT_FOUND');
  });
});
