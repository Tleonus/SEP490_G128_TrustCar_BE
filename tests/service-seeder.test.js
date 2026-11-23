/**
 * @file service-seeder.test.js
 * @description KAN-96: the showroom service seeder creates the six default packages once and
 * never overwrites a package an admin has since edited.
 */

import { jest } from '@jest/globals';
import ShowroomService from '../src/models/showroom-service.model.js';
import { seedShowroomServices } from '../src/seeders/showroomServiceSeeder.js';

const EXPECTED_CODES = [
  'CAR_WASH_PREMIUM', 'POLISH', 'CERAMIC_COATING', 'UNDERBODY_COATING', 'INTERIOR_DETAIL', 'GENERAL_INSPECTION',
];

let stored;

const lean = (value) => ({ lean: async () => value });

beforeEach(() => {
  stored = [];
  jest.spyOn(ShowroomService, 'findOne').mockImplementation((filter) =>
    lean(stored.find((row) => row.code === filter.code) ?? null));
  jest.spyOn(ShowroomService, 'create').mockImplementation(async (doc) => {
    stored.push(doc);
    return doc;
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('seedShowroomServices', () => {
  test('an empty database gets all six packages, active', async () => {
    const result = await seedShowroomServices();

    expect(result).toEqual({ created: 6, skipped: 0 });
    expect(stored.map((row) => row.code)).toEqual(EXPECTED_CODES);
    stored.forEach((row) => expect(row.status).toBe('ACTIVE'));
    expect(stored.find((row) => row.code === 'CERAMIC_COATING').referencePrice).toBe(3_000_000);
    expect(stored.find((row) => row.code === 'CAR_WASH_PREMIUM').referencePrice).toBe(200_000);
  });

  test('running it twice creates nothing the second time', async () => {
    await seedShowroomServices();
    const second = await seedShowroomServices();

    expect(second).toEqual({ created: 0, skipped: 6 });
    expect(stored).toHaveLength(6);
  });

  test('an admin price edit survives a later seed', async () => {
    await seedShowroomServices();
    stored.find((row) => row.code === 'POLISH').referencePrice = 950_000;
    stored.find((row) => row.code === 'POLISH').serviceName = 'Đánh bóng sơn 2 bước';

    await seedShowroomServices();

    const polish = stored.find((row) => row.code === 'POLISH');
    expect(polish.referencePrice).toBe(950_000);
    expect(polish.serviceName).toBe('Đánh bóng sơn 2 bước');
    expect(stored.filter((row) => row.code === 'POLISH')).toHaveLength(1);
  });

  test('a missing package is filled in without touching the others', async () => {
    stored.push({ code: 'POLISH', serviceName: 'Đã sửa', referencePrice: 1, status: 'INACTIVE' });

    const result = await seedShowroomServices();

    expect(result).toEqual({ created: 5, skipped: 1 });
    expect(stored.find((row) => row.code === 'POLISH')).toMatchObject({ serviceName: 'Đã sửa', status: 'INACTIVE' });
    expect(stored).toHaveLength(6);
  });
});
