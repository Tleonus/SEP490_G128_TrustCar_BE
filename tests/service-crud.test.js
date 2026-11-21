/**
 * @file service-crud.test.js
 * @description KAN-96: showroom service CRUD. ShowroomService persistence is replaced, so no
 * database is touched. Covers creation, the immutable code, the duplicate-code translation,
 * the update allow-list and the soft delete.
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import ShowroomService from '../src/models/showroom-service.model.js';
import {
  createService, updateService, deactivateService, listPublicServices, getAdminService,
} from '../src/services/showroomServiceService.js';

const id = () => new mongoose.Types.ObjectId();
const lean = (value) => ({ lean: async () => value });

let stored;

const persist = (doc) => {
  const row = { _id: id(), createdAt: new Date(), updatedAt: new Date(), ...doc };
  stored.push(row);
  return row;
};

beforeEach(() => {
  stored = [];
  jest.spyOn(ShowroomService, 'create').mockImplementation(async (doc) => {
    if (stored.some((row) => row.code === doc.code)) {
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }
    // Run the payload through the real schema so defaults and validation apply,
    // exactly as Mongoose would before persisting.
    const validated = new ShowroomService(doc);
    const error = validated.validateSync();
    if (error) throw error;
    return persist(validated.toObject());
  });
  jest.spyOn(ShowroomService, 'findById').mockImplementation((target) =>
    lean(stored.find((row) => String(row._id) === String(target)) ?? null));
  jest.spyOn(ShowroomService, 'findByIdAndUpdate').mockImplementation((target, update) => {
    const row = stored.find((entry) => String(entry._id) === String(target));
    if (row) Object.assign(row, update.$set, { updatedAt: new Date() });
    return lean(row ?? null);
  });
  jest.spyOn(ShowroomService, 'find').mockImplementation((filter = {}) => {
    const rows = stored.filter((row) => !filter.status || row.status === filter.status);
    const chain = { sort: () => chain, skip: () => chain, limit: () => chain, lean: async () => rows };
    return chain;
  });
});

afterEach(() => jest.restoreAllMocks());

const admin = new mongoose.Types.ObjectId();

const valid = (extra = {}) => ({
  code: 'CERAMIC_COATING', serviceName: 'Phủ nano ceramic', description: 'Bảo vệ 12 tháng',
  estimatedDuration: 240, referencePrice: 3_000_000, ...extra,
});

describe('createService', () => {
  test('stores an active package and returns the admin view', async () => {
    const dto = await createService(valid(), admin);

    expect(dto).toMatchObject({ code: 'CERAMIC_COATING', status: 'ACTIVE', referencePrice: 3_000_000 });
    expect(dto.id).toBeDefined();
    expect(stored[0].createdBy).toBe(admin);
  });

  test('a repeated code is a 409', async () => {
    await createService(valid(), admin);
    await expect(createService(valid(), admin)).rejects.toMatchObject({ statusCode: 409, code: 'DUPLICATE_SERVICE_CODE' });
    expect(stored).toHaveLength(1);
  });
});

describe('updateService', () => {
  test('changes the price and name but records who did it', async () => {
    const created = await createService(valid(), admin);
    const editor = new mongoose.Types.ObjectId();

    const dto = await updateService(created.id, { serviceName: 'Phủ nano 9H', referencePrice: 3_500_000 }, editor);

    expect(dto).toMatchObject({ serviceName: 'Phủ nano 9H', referencePrice: 3_500_000, code: 'CERAMIC_COATING' });
    expect(String(stored[0].updatedBy)).toBe(String(editor));
  });

  test('the code cannot be changed', async () => {
    const created = await createService(valid(), admin);
    await expect(updateService(created.id, { code: 'RENAMED' }, admin))
      .rejects.toMatchObject({ statusCode: 400, code: 'SERVICE_CODE_IMMUTABLE' });
    expect(stored[0].code).toBe('CERAMIC_COATING');
  });

  test('an unknown id is a 404', async () => {
    await expect(updateService(id(), { serviceName: 'Xyz' }, admin))
      .rejects.toMatchObject({ statusCode: 404, code: 'SERVICE_NOT_FOUND' });
  });
});

describe('deactivateService', () => {
  test('flips the status to INACTIVE and keeps the document', async () => {
    const created = await createService(valid(), admin);

    const dto = await deactivateService(created.id, admin);

    expect(dto.status).toBe('INACTIVE');
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('INACTIVE');
  });

  test('a deactivated package disappears from the public list', async () => {
    const created = await createService(valid(), admin);
    await createService(valid({ code: 'POLISH', serviceName: 'Đánh bóng' }), admin);
    await deactivateService(created.id, admin);

    const pub = await listPublicServices();

    expect(pub.map((row) => row.code)).toEqual(['POLISH']);
    expect(pub[0]).not.toHaveProperty('status');
  });

  test('an unknown id is a 404', async () => {
    await expect(deactivateService(id(), admin)).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });
  });
});

describe('getAdminService', () => {
  test('returns the admin view including status', async () => {
    const created = await createService(valid(), admin);
    const dto = await getAdminService(created.id);
    expect(dto).toMatchObject({ code: 'CERAMIC_COATING', status: 'ACTIVE' });
  });
});
