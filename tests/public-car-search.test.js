/**
 * @file public-car-search.test.js
 * @description KAN-32: the public catalog accepts every multi-filter param,
 * paginates, and never exposes cost or identity fields.
 */

import { jest } from '@jest/globals';

const find = jest.fn();
const countDocuments = jest.fn();

jest.unstable_mockModule('../src/models/Car.js', () => ({
  default: { find: (...args) => find(...args), countDocuments: (...args) => countDocuments(...args) },
}));

const { getAvailableCars } = await import('../src/services/publicCarService.js');

const chain = (rows) => ({ sort: () => chain(rows), skip: () => chain(rows), limit: () => chain(rows), lean: async () => rows });

beforeEach(() => {
  find.mockReset();
  countDocuments.mockReset();
  countDocuments.mockResolvedValue(0);
  find.mockReturnValue(chain([]));
});

const filterOf = () => find.mock.calls.at(-1)[0];

test('a single make filter matches that brand exactly and stays public-only', async () => {
  await getAvailableCars({ make: 'Toyota' });

  expect(filterOf()).toMatchObject({ status: 'AVAILABLE', isActive: true, make: 'TOYOTA' });
});

test('combines make, fuel type and a price range', async () => {
  await getAvailableCars({ make: 'Toyota', fuelType: 'GASOLINE', minPrice: '500000000', maxPrice: '1000000000' });

  expect(filterOf()).toMatchObject({
    make: 'TOYOTA',
    fuelType: 'GASOLINE',
    price: { $gte: 500000000, $lte: 1000000000 },
  });
});

test('a keyword searches make, model, variant and vehicleCode without case', async () => {
  await getAvailableCars({ search: 'Camry' });

  const or = filterOf().$or;
  expect(or.map((clause) => Object.keys(clause)[0])).toEqual(['make', 'model', 'variant', 'vehicleCode']);
  for (const clause of or) {
    expect(Object.values(clause)[0]).toEqual({ $regex: 'Camry', $options: 'i' });
  }
});

test('treats a keyword as literal text', async () => {
  await getAvailableCars({ search: 'C.+' });

  expect(filterOf().$or[0].make.$regex).toBe('C\\.\\+');
});

test('matches comma-separated lists with $in', async () => {
  await getAvailableCars({
    make: 'Toyota, Honda',
    model: 'Camry,Civic',
    fuelType: 'GASOLINE,DIESEL,ELECTRIC',
    transmission: 'AUTOMATIC,MANUAL',
    bodyType: 'SUV,SEDAN',
  });

  expect(filterOf()).toMatchObject({
    make: { $in: ['TOYOTA', 'HONDA'] },
    model: { $in: ['Camry', 'Civic'] },
    fuelType: { $in: ['GASOLINE', 'DIESEL', 'ELECTRIC'] },
    transmission: { $in: ['AUTOMATIC', 'MANUAL'] },
    bodyType: { $in: ['SUV', 'SEDAN'] },
  });
});

test('filters colour, year and mileage', async () => {
  await getAvailableCars({ color: 'Đỏ', minYear: '2020', maxYear: '2024', maxMileage: '50000' });

  const filter = filterOf();
  expect(filter['specifications.color']).toEqual({ $regex: '^Đỏ$', $options: 'i' });
  expect(filter.year).toEqual({ $gte: 2020, $lte: 2024 });
  expect(filter.mileage).toEqual({ $lte: 50000 });
});

test('applies the KAN-32 sort tokens', async () => {
  const sorts = [];
  find.mockImplementation(() => ({
    sort: (value) => { sorts.push(value); return chain([]); },
  }));

  for (const [sortBy, expected] of [
    ['price_asc', { price: 1 }],
    ['price_desc', { price: -1 }],
    ['year_desc', { year: -1 }],
    ['mileage_asc', { mileage: 1 }],
    ['newest', { createdAt: -1 }],
    ['unknown', { createdAt: -1 }],
  ]) {
    await getAvailableCars({ sortBy });
    expect(sorts.at(-1)).toEqual(expected);
  }

  await getAvailableCars({ sortBy: 'price', sortDir: 'asc' });
  expect(sorts.at(-1)).toEqual({ price: 1 });
});

test('paginates and reports totalPages', async () => {
  const skips = [];
  const limits = [];
  find.mockImplementation(() => ({
    sort: () => ({
      skip: (value) => { skips.push(value); return { limit: (n) => { limits.push(n); return { lean: async () => [] }; } }; },
    }),
  }));
  countDocuments.mockResolvedValue(45);

  const { pagination } = await getAvailableCars({ page: '3', limit: '10' });

  expect(skips).toEqual([20]);
  expect(limits).toEqual([10]);
  expect(pagination).toMatchObject({ total: 45, page: 3, limit: 10, totalPages: 5 });
});

test('strips cost and identity fields even if the projection leaks them', async () => {
  find.mockReturnValue(chain([{
    make: 'TOYOTA',
    floorPrice: 100,
    originalPrice: 200,
    vin: 'VIN12345678901234',
    licensePlate: '30A-12345',
    internalNotes: 'secret',
    priceHistory: [{ price: 1 }],
  }]));

  const { items } = await getAvailableCars({});

  expect(items[0]).toEqual({ make: 'TOYOTA' });
  expect(find.mock.calls[0][1]).toMatchObject({ cpoCertificateId: 1 });
  expect(find.mock.calls[0][1]).not.toHaveProperty('floorPrice');
});

test('keeps the legacy param names the current front-end sends', async () => {
  await getAvailableCars({ brand: 'Honda', priceMin: '100', priceMax: '200', yearMin: '2019', mileageMax: '80000' });

  expect(filterOf()).toMatchObject({
    make: 'HONDA',
    price: { $gte: 100, $lte: 200 },
    year: { $gte: 2019 },
    mileage: { $lte: 80000 },
  });
});
