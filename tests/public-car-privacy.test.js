/**
 * @file public-car-privacy.test.js
 * @description Public car list, detail and featured responses never carry cost
 * prices, inventory metrics, vehicle identity or audit data, show the market
 * price, and featured cars are only cars on sale.
 *
 * Runs the real app on the in-memory auth harness (no MongoDB). `Car.find` and
 * `Car.findOne` return documents carrying every internal field, ignoring the
 * projection, so the checks prove the post-query guard on its own; separate
 * assertions check the projections themselves.
 *
 * Ref: .sdd/features/kan-47-prevent-cost-price-leakage/SPEC.md
 *      (REQ-001…009, 015, 018; AC-01…08, 13, 16, 17)
 */

import mongoose from 'mongoose';
import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
// Loaded after the harness so its jest.unstable_mockModule paths bind to tests/helpers.
const { jest } = await import('@jest/globals');
const { default: Car } = await import('../src/models/Car.js');

const oid = () => new mongoose.Types.ObjectId().toString();
// Each request gets its own client IP so the global rate limiter stays out of the way.
const get = (url) => request(h.app).get(url).set('X-Forwarded-For', h.nextIp());

const INTERNAL_FIELDS = [
  'originalPrice', 'floorPrice', 'listedPrice', 'priceDropCount', 'priceHistory',
  'daysInStock', 'agingCategory', 'inventoryType', 'listedDate', 'internalNotes',
  'vin', 'licensePlate', 'carModelRef', 'soldAt', 'statusChangedAt',
  'createdBy', 'updatedBy', 'statusChangedBy', 'isActive',
];

const DETAIL_FIELDS = [
  '_id', 'vehicleCode', 'make', 'model', 'variant', 'year', 'bodyType', 'fuelType',
  'transmission', 'driveType', 'mileage', 'specifications', 'price', 'marketPrice', 'ownerType',
  'status', 'cpoCertificateId', 'images', 'description', 'conditionGrade', 'registrationExpiry',
  'createdAt', 'updatedAt',
];

/** A stored car carrying every public and internal field. */
const fullCar = (overrides = {}) => ({
  _id: oid(),
  vehicleCode: 'TC-2026-0001',
  make: 'KIA', model: 'Sonet', variant: 'Premium', year: 2022,
  bodyType: 'SUV', fuelType: 'PETROL', transmission: 'AUTOMATIC', driveType: 'FWD', mileage: 21000,
  specifications: { color: 'Đỏ', numberOfSeats: 5, torqueNm: 144 },
  price: 520000000,
  marketPrice: 550000000,
  ownerType: 'FIRST_OWNER',
  status: 'AVAILABLE',
  cpoCertificateId: 'CPO-2026-0001',
  images: [{
    _id: oid(), url: 'https://cdn.example.com/a.jpg', isPrimary: true,
    publicId: 'trustcar/secret-asset', caption: 'front', uploadedAt: new Date(),
  }],
  description: 'Xe gia đình',
  conditionGrade: 'A',
  registrationExpiry: new Date('2027-01-01'),
  createdAt: new Date('2026-10-01'),
  updatedAt: new Date('2026-10-02'),
  originalPrice: 430000000,
  floorPrice: 480000000,
  listedPrice: 520000000,
  priceDropCount: 1,
  priceHistory: [{ price: 540000000 }],
  daysInStock: 40,
  agingCategory: 'SLOW',
  inventoryType: 'OWNED',
  listedDate: new Date('2026-09-01'),
  internalNotes: 'giá thu thấp',
  vin: '1HGCM82633A004352',
  licensePlate: '51A-12345',
  carModelRef: oid(),
  soldAt: null,
  statusChangedAt: new Date(),
  createdBy: oid(),
  updatedBy: oid(),
  statusChangedBy: oid(),
  isActive: true,
  ...overrides,
});

/** Query-builder stand-in resolving to `docs` (copied so each request gets fresh objects). */
const chain = (docs) => {
  const c = {
    sort: () => c,
    skip: () => c,
    limit: (n) => { c.limitArg = n; return c; },
    lean: async () => structuredClone(docs),
  };
  return c;
};

const spies = [];
const spy = (object, method) => {
  const s = jest.spyOn(object, method);
  spies.push(s);
  return s;
};

beforeEach(() => {
  h.reset();
  while (spies.length) spies.pop().mockRestore();
});

const expectNoInternalFields = (car) => {
  for (const field of INTERNAL_FIELDS) expect(car).not.toHaveProperty(field);
  for (const image of car.images ?? []) expect(Object.keys(image).sort()).toEqual(['_id', 'isPrimary', 'url']);
};

describe('GET /api/v1/public/cars/:id (detail)', () => {
  test('AC-01: by _id returns the allowed fields and no internal field', async () => {
    const car = fullCar();
    const findOne = spy(Car, 'findOne').mockReturnValue({ lean: async () => structuredClone(car) });

    const res = await get(`/api/v1/public/cars/${car._id}`);

    expect(res.status).toBe(200);
    expectNoInternalFields(res.body.data);
    expect(Object.keys(res.body.data).sort()).toEqual([...DETAIL_FIELDS].sort());
    expect(res.body.data.specifications.torqueNm).toBe(144);
    expect(findOne.mock.calls[0][0]).toMatchObject({ _id: car._id, status: 'AVAILABLE', isActive: true });
  });

  test('AC-02: by vehicleCode applies the same rules', async () => {
    const car = fullCar();
    const findOne = spy(Car, 'findOne').mockReturnValue({ lean: async () => structuredClone(car) });

    const res = await get('/api/v1/public/cars/TC-2026-0001');

    expect(res.status).toBe(200);
    expectNoInternalFields(res.body.data);
    expect(findOne.mock.calls[0][0]).toMatchObject({ vehicleCode: 'TC-2026-0001', status: 'AVAILABLE' });
  });

  test('AC-03: a car not on sale is 404 NOT_FOUND', async () => {
    spy(Car, 'findOne').mockReturnValue({ lean: async () => null });

    const res = await get(`/api/v1/public/cars/${oid()}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('AC-08: the detail projection is an allow-list', async () => {
    const findOne = spy(Car, 'findOne').mockReturnValue({ lean: async () => fullCar() });

    await get(`/api/v1/public/cars/${oid()}`);

    const projection = findOne.mock.calls[0][1];
    expect(Object.values(projection).every((v) => v === 1)).toBe(true);
    for (const field of INTERNAL_FIELDS) expect(projection).not.toHaveProperty(field);
  });

  test('AC-16: one Car query per request', async () => {
    const findOne = spy(Car, 'findOne').mockReturnValue({ lean: async () => fullCar() });
    await get(`/api/v1/public/cars/${oid()}`);
    expect(findOne).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/v1/public/cars/featured', () => {
  const stubFind = (docs = [fullCar()]) => {
    const c = chain(docs);
    const find = spy(Car, 'find').mockReturnValue(c);
    return { find, c };
  };

  test('AC-04: only AVAILABLE active cars, newest first', async () => {
    const { find, c } = stubFind();
    const sort = jest.fn(() => c);
    c.sort = sort;

    const res = await get('/api/v1/public/cars/featured');

    expect(res.status).toBe(200);
    expect(find.mock.calls[0][0]).toEqual({ status: 'AVAILABLE', isActive: true });
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
  });

  test('AC-05, AC-08: catalog fields only, allow-list projection, no internal field', async () => {
    const { find } = stubFind();

    const res = await get('/api/v1/public/cars/featured');

    const projection = find.mock.calls[0][1];
    expect(Object.values(projection).every((v) => v === 1)).toBe(true);
    expect(projection).not.toHaveProperty('ownerType');
    expectNoInternalFields(res.body.data[0]);
  });

  test.each([
    [undefined, 8], ['abc', 8], ['0', 8], ['50', 20], ['5', 5],
  ])('AC-06: limit=%p → %p', async (limit, expected) => {
    const { c } = stubFind();
    const url = limit === undefined ? '/api/v1/public/cars/featured' : `/api/v1/public/cars/featured?limit=${limit}`;

    await get(url);

    expect(c.limitArg).toBe(expected);
  });

  test('AC-16: one Car query per request', async () => {
    const { find } = stubFind();
    await get('/api/v1/public/cars/featured');
    expect(find).toHaveBeenCalledTimes(1);
  });
});

describe('Second guard and images (list, detail, featured)', () => {
  test('AC-07, AC-17: list strips internal fields and trims images even if the projection leaks', async () => {
    spy(Car, 'find').mockReturnValue(chain([fullCar()]));
    spy(Car, 'countDocuments').mockResolvedValue(1);

    const res = await get('/api/v1/public/cars');

    expect(res.status).toBe(200);
    const [car] = res.body.data;
    expectNoInternalFields(car);
    expect(car.images[0].url).toBe('https://cdn.example.com/a.jpg');
  });

  test('AC-17: images keep _id for the storefront list key', async () => {
    const car = fullCar();
    spy(Car, 'findOne').mockReturnValue({ lean: async () => structuredClone(car) });

    const res = await get(`/api/v1/public/cars/${car._id}`);

    expect(res.body.data.images[0]._id).toBe(car.images[0]._id);
    expect(res.body.data.images[0]).not.toHaveProperty('publicId');
  });
});

describe('AC-13 / REQ-015: market price on public responses', () => {
  test('present when entered', async () => {
    spy(Car, 'find').mockReturnValue(chain([fullCar()]));
    const res = await get('/api/v1/public/cars/featured');
    expect(res.body.data[0].marketPrice).toBe(550000000);
  });

  test('null when the car has none (list, detail, featured)', async () => {
    const withoutMarket = fullCar();
    delete withoutMarket.marketPrice;
    spy(Car, 'find').mockReturnValue(chain([withoutMarket]));
    spy(Car, 'countDocuments').mockResolvedValue(1);
    spy(Car, 'findOne').mockReturnValue({ lean: async () => structuredClone(withoutMarket) });

    const list = await get('/api/v1/public/cars');
    const featured = await get('/api/v1/public/cars/featured');
    const detail = await get(`/api/v1/public/cars/${withoutMarket._id}`);

    expect(list.body.data[0].marketPrice).toBeNull();
    expect(featured.body.data[0].marketPrice).toBeNull();
    expect(detail.body.data.marketPrice).toBeNull();
  });

  test('list projection includes marketPrice', async () => {
    const find = spy(Car, 'find').mockReturnValue(chain([]));
    spy(Car, 'countDocuments').mockResolvedValue(0);
    await get('/api/v1/public/cars');
    expect(find.mock.calls[0][1]).toMatchObject({ marketPrice: 1 });
  });
});
