/**
 * @file inspection-harness.test.js
 * @description Self-checks for the in-memory inspection harness and the
 * withTransaction helper: commit keeps writes, failure rolls every write back,
 * transactions are serialised and unique indexes are enforced.
 */

import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';

const h = await setupInspectionHarness();
const { withTransaction } = await import('../src/utils/withTransaction.js');

beforeEach(() => h.reset());

const draft = (carId) => ({ carId, status: 'DRAFT', source: 'STAFF', checklistVersion: '1.0' });

describe('withTransaction on the inspection harness', () => {
  test('commit keeps every write made with the session', async () => {
    const carId = h.createCar();

    const id = await withTransaction(async (session) => {
      const car = await h.Car.findById(carId).session(session);
      car.status = 'UNDER_INSPECTION';
      await car.save({ session });
      const [record] = await h.InspectionRecord.create([draft(carId)], { session });
      return String(record._id);
    });

    expect(h.car(carId).status).toBe('UNDER_INSPECTION');
    expect(h.record(id).status).toBe('DRAFT');
    expect(h.sessionStats).toMatchObject({ started: 1, committed: 1, aborted: 0 });
  });

  test('a failure rolls back writes made before it and rethrows', async () => {
    const carId = h.createCar();

    await expect(withTransaction(async (session) => {
      await h.InspectionRecord.create([draft(carId)], { session });
      const car = await h.Car.findById(carId).session(session);
      car.status = 'UNDER_INSPECTION';
      await car.save({ session });
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(h.car(carId).status).toBe('INCOMING');
    expect(h.records.size).toBe(0);
    expect(h.sessionStats).toMatchObject({ aborted: 1, committed: 0 });
  });

  test('transactions run one at a time', async () => {
    const order = [];
    const work = (name) => withTransaction(async () => {
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${name}:end`);
    });

    await Promise.all([work('a'), work('b')]);

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });
});

describe('emulated indexes and faults', () => {
  test('a second DRAFT for the same car raises E11000; a SUBMITTED one does not', async () => {
    const carId = h.createCar();
    await h.InspectionRecord.create([draft(carId)]);

    await expect(h.InspectionRecord.create([draft(carId)])).rejects.toMatchObject({ code: 11000 });
    h.insertRecord({ carId, status: 'SUBMITTED' });
    expect(h.records.size).toBe(2);
  });

  test('duplicate Car.cpoCertificateId raises E11000', async () => {
    h.createCar({ cpoCertificateId: 'CPO-20261102-AAAA' });
    const carId = h.createCar();
    const car = await h.Car.findById(carId);
    car.cpoCertificateId = 'CPO-20261102-AAAA';

    await expect(car.save()).rejects.toMatchObject({ code: 11000 });
  });

  test('failNextCarSaves makes the next save throw once', async () => {
    const carId = h.createCar();
    h.failNextCarSaves(1);
    const car = await h.Car.findById(carId);

    await expect(car.save()).rejects.toThrow('Simulated write failure');
    await expect(car.save()).resolves.toBeDefined();
  });

  test('findOneAndUpdate only matches the given status and validates the result', async () => {
    const id = h.insertRecord(draft(h.createCar()));
    const verdict = {
      status: 'SUBMITTED', inspectorId: h.records.get(id).carId, odo: 1, result: 'FAILED',
      criteria: { noMajorAccident: false, noWaterDamage: true, engineGearboxIntact: true, verifiedOdo: true, electricalSystemPassed: true },
    };

    await expect(h.InspectionRecord.findOneAndUpdate({ _id: id, status: 'DRAFT' }, { $set: { status: 'SUBMITTED' } }))
      .rejects.toBeDefined(); // SUBMITTED without verdict fields is invalid → nothing written
    expect(h.record(id).status).toBe('DRAFT');

    const first = await h.InspectionRecord.findOneAndUpdate({ _id: id, status: 'DRAFT' }, { $set: verdict }, { new: true }).lean();
    const second = await h.InspectionRecord.findOneAndUpdate({ _id: id, status: 'DRAFT' }, { $set: verdict }, { new: true }).lean();

    expect(first.status).toBe('SUBMITTED');
    expect(second).toBeNull();
  });
});
