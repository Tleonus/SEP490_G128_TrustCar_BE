/**
 * @file car-compare.test.js
 * @description GET /api/v1/customer/cars/compare – result content (customer-only comparison).
 * Access and input validation live in car-compare-access.test.js.
 *
 * Runs the real app on the in-memory auth harness (no MongoDB). `Car.find` is
 * replaced by a fake over an in-memory array that IGNORES the projection, so the
 * leak checks prove the DTO mapper on its own, not just the database projection.
 *
 * Ref: .sdd/features/vehicle-comparison/SPEC.md (REQ-006, 009–013; AC-01…06, 12)
 */

import mongoose from 'mongoose';
import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
// Loaded after the harness on purpose: importing it first would bind the harness's
// jest.unstable_mockModule paths to this file instead of tests/helpers.
const { jest } = await import('@jest/globals');
const { signAccessToken } = await import('../src/utils/authTokens.js');
const { default: Car } = await import('../src/models/Car.js');
const { COMPARE_PROJECTION } = await import('../src/services/carCompareService.js');

const URL = '/api/v1/customer/cars/compare';
const oid = () => new mongoose.Types.ObjectId().toString();

const ALLOWED_TOP = [
  '_id', 'vehicleCode', 'make', 'model', 'variant', 'year', 'bodyType', 'fuelType', 'transmission',
  'driveType', 'mileage', 'price', 'ownerType', 'conditionGrade', 'primaryImageUrl', 'specifications',
];
const ALLOWED_SPECS = [
  'color', 'interiorColor', 'numberOfSeats', 'numberOfDoors', 'engineDisplacementCC', 'horsePower',
  'torqueNm', 'fuelConsumption', 'originCountry', 'safetyRating', 'features',
];

/** A car document carrying every internal/forbidden field with a SENTINEL value. */
const makeCar = (overrides = {}) => ({
  _id: oid(), vehicleCode: 'TC-2026-0001', make: 'KIA', model: 'Sonet', variant: 'Premium', year: 2022,
  bodyType: 'SUV', fuelType: 'PETROL', transmission: 'AUTOMATIC', driveType: 'FWD', mileage: 21000,
  price: 555000000, ownerType: 'INDIVIDUAL', conditionGrade: 'B', status: 'AVAILABLE', isActive: true,
  vin: 'SENTINEL-VIN', licensePlate: 'SENTINEL-PLATE', floorPrice: 111, originalPrice: 222, listedPrice: 333,
  priceDropCount: 7, daysInStock: 99, agingCategory: 'SLOW', inventoryType: 'OWNED', listedDate: new Date(),
  soldAt: new Date(), registrationExpiry: new Date(), internalNotes: 'SENTINEL-NOTE',
  priceHistory: [{ price: 1, reason: 'SENTINEL-HISTORY' }], createdBy: oid(), updatedBy: oid(), statusChangedBy: oid(),
  images: [
    { url: 'https://img/1.jpg', publicId: 'SENTINEL-PUBLIC-ID', isPrimary: false },
    { url: 'https://img/2.jpg', publicId: 'SENTINEL-PUBLIC-ID', isPrimary: true },
  ],
  specifications: {
    color: 'White', interiorColor: 'Black', numberOfSeats: 5, numberOfDoors: 5, engineDisplacementCC: 1497,
    horsePower: 113, torqueNm: 144, fuelConsumption: 6.5, originCountry: 'India', safetyRating: '5-star',
    features: ['Sunroof'], importType: 'SENTINEL-IMPORT', fuelTankLiters: 42, engineCylinders: 4,
  },
  ...overrides,
});

let store = [];
let findCalls = [];
jest.spyOn(Car, 'find').mockImplementation((filter) => {
  findCalls.push(filter);
  const wanted = new Set(filter._id.$in.map(String));
  const rows = store.filter((c) => wanted.has(String(c._id)) && c.status === filter.status && c.isActive === filter.isActive);
  return { lean: async () => rows.slice().reverse() }; // reversed: the service must restore request order
});

const customerToken = async () => {
  const { id } = await h.createUser({ roleName: 'CUSTOMER', phone: '0901234567' });
  return signAccessToken(await h.User.findById(id).select('+tokenVersion'));
};
const compare = (ids, token) => request(h.app).get(`${URL}?ids=${ids}`)
  .set('X-Forwarded-For', h.nextIp()).set('Authorization', `Bearer ${token}`);
const keysOf = (obj) => Object.keys(obj).sort();

beforeEach(() => {
  h.reset();
  store = [];
  findCalls = [];
});

describe('success path (REQ-001, 006, 009, 012)', () => {
  test('AC-01: 3 available cars come back in the requested order with no unavailable ids', async () => {
    store = [makeCar(), makeCar(), makeCar()];
    const [a, b, c] = store.map((x) => x._id);
    const res = await compare(`${c},${a},${b}`, await customerToken());

    expect(res.status).toBe(200);
    expect(res.body.data.cars.map((x) => x._id)).toEqual([c, a, b]);
    expect(res.body.data.unavailableIds).toEqual([]);
    expect(findCalls).toHaveLength(1); // NFR-01
    expect(findCalls[0]).toMatchObject({ status: 'AVAILABLE', isActive: true });
  });

  test('AC-02: no internal field appears anywhere, even though the fake ignores the projection', async () => {
    store = [makeCar(), makeCar()];
    const res = await compare(store.map((x) => x._id).join(','), await customerToken());
    const body = JSON.stringify(res.body);

    expect(body).not.toMatch(/SENTINEL/);
    res.body.data.cars.forEach((car) => {
      expect(keysOf(car)).toEqual([...ALLOWED_TOP].sort());
      expect(keysOf(car.specifications)).toEqual([...ALLOWED_SPECS].sort());
    });
    ['vin', 'floorPrice', 'priceHistory', 'internalNotes', 'status', 'isActive', 'createdBy'].forEach((key) => {
      expect(body).not.toContain(`"${key}"`);
    });
    expect(Object.keys(COMPARE_PROJECTION).filter((p) => /vin|floor|history|notes|publicId/i.test(p))).toEqual([]);
  });

  test('primary image wins, then first image, then null; missing data becomes null / []', async () => {
    store = [
      makeCar(),
      makeCar({ images: [{ url: 'https://img/only.jpg', isPrimary: false }] }),
      makeCar({ images: [], conditionGrade: undefined, specifications: {} }),
    ];
    const res = await compare(store.map((x) => x._id).join(','), await customerToken());
    const [primary, first, bare] = res.body.data.cars;

    expect(primary.primaryImageUrl).toBe('https://img/2.jpg');
    expect(first.primaryImageUrl).toBe('https://img/only.jpg');
    expect(bare.primaryImageUrl).toBeNull();
    expect(bare.conditionGrade).toBeNull();
    expect(bare.specifications.features).toEqual([]);
    expect(bare.specifications.safetyRating).toBeNull();
  });

  test('AC-03: duplicate and mixed-case ids are collapsed before counting', async () => {
    store = [makeCar(), makeCar()];
    const [a, b] = store.map((x) => x._id);
    const res = await compare(` ${a.toUpperCase()} ,${a},${b}`, await customerToken());

    expect(res.status).toBe(200);
    expect(res.body.data.cars.map((x) => x._id)).toEqual([a, b]);
  });
});

describe('unavailable cars (REQ-010, 011)', () => {
  test('AC-04 / AC-05: sold and unknown ids are dropped and listed, without telling them apart', async () => {
    store = [makeCar(), makeCar(), makeCar({ status: 'SOLD' })];
    const [a, b, sold] = store.map((x) => x._id);
    const ghost = oid();
    const token = await customerToken();

    const withSold = await compare(`${a},${sold},${b}`, token);
    expect(withSold.status).toBe(200);
    expect(withSold.body.data.cars.map((x) => x._id)).toEqual([a, b]);
    expect(withSold.body.data.unavailableIds).toEqual([sold]);

    const withGhost = await compare(`${a},${b},${ghost}`, token);
    expect(withGhost.body.data.unavailableIds).toEqual([ghost]);
  });

  test('AC-06: fewer than 2 available cars → 422 COMPARE_NOT_ENOUGH_CARS with unavailableIds and no car data', async () => {
    store = [makeCar(), makeCar({ status: 'DELISTED' }), makeCar({ isActive: false })];
    const [a, delisted, inactive] = store.map((x) => x._id);
    const res = await compare(`${a},${delisted},${inactive}`, await customerToken());

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('COMPARE_NOT_ENOUGH_CARS');
    expect(res.body.errors.unavailableIds).toEqual([delisted, inactive]);
    expect(res.body.data).toBeUndefined();
  });
});

describe('read-only (REQ-013)', () => {
  test('AC-12: a successful comparison changes no car and creates no activity log', async () => {
    store = [makeCar(), makeCar()];
    const before = JSON.stringify(store);
    const token = await customerToken();
    h.logs.length = 0;
    const res = await compare(store.map((x) => x._id).join(','), token);

    expect(res.status).toBe(200);
    expect(JSON.stringify(store)).toBe(before);
    expect(h.logs).toHaveLength(0);
  });
});
