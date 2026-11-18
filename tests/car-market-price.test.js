/**
 * @file car-market-price.test.js
 * @description Staff enter, change and clear a car's market price through the
 * car management API. The market price is shown to customers next to the
 * selling price but never touches the selling price, its history or the
 * wishlist price-drop email.
 *
 * Runs the real app on the in-memory auth harness (no MongoDB). `Car` reads and
 * writes are replaced by spies over plain objects.
 *
 * Ref: .sdd/features/kan-47-prevent-cost-price-leakage/SPEC.md
 *      (REQ-010…014, 016, 017; AC-09…12, 14, 15)
 */

import mongoose from 'mongoose';
import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
// Loaded after the harness so its jest.unstable_mockModule paths bind to tests/helpers.
const { jest } = await import('@jest/globals');
const { signAccessToken } = await import('../src/utils/authTokens.js');
const { default: Car } = await import('../src/models/Car.js');
const { default: ActivityLog } = await import('../src/models/ActivityLog.js');

const URL = '/api/v1/manage/cars';
const oid = () => new mongoose.Types.ObjectId().toString();

/** Promise that also answers the query-builder calls the services chain onto it. */
const query = (value) => {
  const p = Promise.resolve(value);
  p.lean = () => query(value);
  p.select = () => query(value);
  p.populate = () => query(value);
  return p;
};

// Only this file's spies are restored: the harness keeps its own spies on User/Role.
const spies = [];
const spy = (object, method) => {
  const s = jest.spyOn(object, method);
  spies.push(s);
  return s;
};

let adminToken;
const as = (token) => ({ Authorization: `Bearer ${token}`, 'X-Forwarded-For': h.nextIp() });

const validCreateBody = (overrides = {}) => ({
  vin: '1HGCM82633A004352',
  licensePlate: '51A-12345',
  make: 'KIA',
  model: 'Sonet',
  year: 2022,
  price: 520000000,
  ...overrides,
});

/** Stored car as `Car.findOne` returns it to `updateCar` (a hydrated-like document). */
const storedCar = (overrides = {}) => {
  const doc = {
    _id: oid(),
    vehicleCode: 'TC-2026-0001',
    vin: '1HGCM82633A004352',
    licensePlate: '51A-12345',
    status: 'AVAILABLE',
    isActive: true,
    mileage: 21000,
    price: 520000000,
    originalPrice: 430000000,
    floorPrice: 480000000,
    priceDropCount: 0,
    marketPrice: 550000000,
    priceHistory: [{ price: 520000000, reason: 'Initial intake price' }],
    ...overrides,
  };
  doc.save = jest.fn(async () => doc);
  doc.toJSON = () => {
    const { save, toJSON, ...plain } = doc;
    return plain;
  };
  return doc;
};

beforeEach(async () => {
  h.reset();
  while (spies.length) spies.pop().mockRestore();
  spy(ActivityLog, 'log').mockResolvedValue(undefined);
  const { id } = await h.createUser({ roleName: 'ADMIN' });
  const user = await h.User.findById(id).select('+tokenVersion');
  adminToken = signAccessToken(user);
});

describe('AC-09 / REQ-011: create stores the market price', () => {
  const stubCreate = () => {
    spy(Car, 'exists').mockResolvedValue(null);
    spy(Car, 'findOne').mockReturnValue(query(null));
    return spy(Car, 'create').mockImplementation(async (doc) => ({ _id: oid(), ...doc }));
  };

  test('marketPrice 550000000 is passed to Car.create and returned', async () => {
    const create = stubCreate();
    const res = await request(h.app).post(URL).set(as(adminToken))
      .send(validCreateBody({ marketPrice: 550000000 }));

    expect(res.status).toBe(201);
    expect(create.mock.calls[0][0].marketPrice).toBe(550000000);
    expect(res.body.data.marketPrice).toBe(550000000);
  });

  test('marketPrice is optional on create', async () => {
    const create = stubCreate();
    const res = await request(h.app).post(URL).set(as(adminToken)).send(validCreateBody());

    expect(res.status).toBe(201);
    expect(create.mock.calls[0][0]).not.toHaveProperty('marketPrice');
  });

  test('REQ-010: the model defaults marketPrice to null', () => {
    const car = new Car(validCreateBody({ vehicleCode: 'TC-2026-0002' }));
    expect(car.marketPrice).toBeNull();
    expect(car.validateSync()?.errors?.marketPrice).toBeUndefined();
  });
});

describe('AC-10 / REQ-012: update replaces or clears the market price', () => {
  test('a new value replaces the stored one', async () => {
    const car = storedCar();
    spy(Car, 'findOne').mockResolvedValue(car);

    const res = await request(h.app).put(`${URL}/${car._id}`).set(as(adminToken))
      .send({ marketPrice: 600000000 });

    expect(res.status).toBe(200);
    expect(car.marketPrice).toBe(600000000);
    expect(car.save).toHaveBeenCalledTimes(1);
  });

  test('null clears the stored value', async () => {
    const car = storedCar();
    spy(Car, 'findOne').mockResolvedValue(car);

    const res = await request(h.app).put(`${URL}/${car._id}`).set(as(adminToken))
      .send({ marketPrice: null });

    expect(res.status).toBe(200);
    expect(car.marketPrice).toBeNull();
  });

  test('an update without marketPrice keeps the stored value', async () => {
    const car = storedCar();
    spy(Car, 'findOne').mockResolvedValue(car);

    await request(h.app).put(`${URL}/${car._id}`).set(as(adminToken)).send({ mileage: 22000 });

    expect(car.marketPrice).toBe(550000000);
  });
});

describe('AC-11 / REQ-013: invalid market prices are rejected', () => {
  test.each([0, -1, 1.5, 'abc'])('create with marketPrice %p → 422', async (value) => {
    const create = spy(Car, 'create');
    const res = await request(h.app).post(URL).set(as(adminToken))
      .send(validCreateBody({ marketPrice: value }));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(create).not.toHaveBeenCalled();
  });

  test.each([0, -1, 1.5, 'abc'])('update with marketPrice %p → 422, car unchanged', async (value) => {
    const car = storedCar();
    const findOne = spy(Car, 'findOne').mockResolvedValue(car);
    const res = await request(h.app).put(`${URL}/${car._id}`).set(as(adminToken))
      .send({ marketPrice: value });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(findOne).not.toHaveBeenCalled();
    expect(car.marketPrice).toBe(550000000);
  });

  test('REQ-010: the model rejects a non-positive marketPrice', () => {
    const car = new Car(validCreateBody({ vehicleCode: 'TC-2026-0003', marketPrice: 0 }));
    expect(car.validateSync().errors.marketPrice).toBeDefined();
  });
});

describe('AC-12 / REQ-014: changing the market price leaves the selling price alone', () => {
  test('price, priceHistory, priceDropCount unchanged and no price-drop email', async () => {
    const car = storedCar();
    spy(Car, 'findOne').mockResolvedValue(car);

    const res = await request(h.app).put(`${URL}/${car._id}`).set(as(adminToken))
      .send({ marketPrice: 450000000 });

    expect(res.status).toBe(200);
    expect(car.price).toBe(520000000);
    expect(car.priceHistory).toHaveLength(1);
    expect(car.priceDropCount).toBe(0);
    expect(h.mail.sent).toHaveLength(0);
    const loggedEvents = ActivityLog.log.mock.calls.map(([entry]) => entry.eventType);
    expect(loggedEvents).not.toContain('CAR_PRICE_UPDATED');
  });
});

describe('AC-14 / REQ-016: the management API still returns internal fields', () => {
  test('GET /manage/cars/:id returns originalPrice, floorPrice, vin and marketPrice', async () => {
    const car = storedCar();
    spy(Car, 'findOne').mockReturnValue(query(car));

    const res = await request(h.app).get(`${URL}/${car._id}`).set(as(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      originalPrice: 430000000,
      floorPrice: 480000000,
      vin: '1HGCM82633A004352',
      marketPrice: 550000000,
    });
  });
});

describe('AC-15 / REQ-017: internal price fields are discarded, never stored', () => {
  test.each(['originalPrice', 'floorPrice', 'listedPrice'])('create with %s → 201, field not stored', async (field) => {
    spy(Car, 'exists').mockResolvedValue(null);
    spy(Car, 'findOne').mockReturnValue(query(null));
    const create = spy(Car, 'create').mockImplementation(async (doc) => ({ _id: oid(), ...doc }));

    const res = await request(h.app).post(URL).set(as(adminToken))
      .send(validCreateBody({ [field]: 400000000 }));

    expect(res.status).toBe(201);
    expect(create.mock.calls[0][0]).not.toHaveProperty(field);
  });

  test.each(['originalPrice', 'floorPrice', 'listedPrice'])('update with %s → 200, field unchanged', async (field) => {
    const car = storedCar({ listedPrice: 520000000 });
    const before = car[field];
    spy(Car, 'findOne').mockResolvedValue(car);

    const res = await request(h.app).put(`${URL}/${car._id}`).set(as(adminToken))
      .send({ [field]: 400000000, mileage: 22000 });

    expect(res.status).toBe(200);
    expect(car[field]).toBe(before);
  });
});
