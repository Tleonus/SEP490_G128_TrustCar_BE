/**
 * @file cpo-certificate-backfill.test.js
 * @description Unit tests for the CPO certificate backfill script (models mocked, no DB):
 * inspector check, dry run writes nothing, apply writes record + car code together,
 * and the written record yields a MINIMAL public report.
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import Car from '../src/models/Car.js';
import InspectionRecord from '../src/models/InspectionRecord.js';
import User from '../src/models/User.js';
import { backfillCpoCertificates } from '../src/seeders/cpoCertificateBackfill.js';
import { buildPublicReport } from '../src/services/inspectionReportMapper.js';

const lean = (value) => ({ select: () => ({ lean: async () => value }), lean: async () => value });
const INSPECTOR = { _id: new mongoose.Types.ObjectId(), fullName: 'Nguyễn Văn An' };
const carA = { _id: new mongoose.Types.ObjectId(), vehicleCode: 'TC-2026-0001', make: 'TOYOTA', model: 'Vios', year: 2020, mileage: 40000, status: 'AVAILABLE' };
const carB = { _id: new mongoose.Types.ObjectId(), vehicleCode: 'TC-2026-0002', make: 'KIA', model: 'Morning', year: 2019, mileage: null, status: 'APPROVED_CPO' };
const quiet = () => {};

let records;
let carUpdates;

beforeEach(() => {
  jest.restoreAllMocks();
  records = [];
  carUpdates = [];
  jest.spyOn(User, 'findOne').mockImplementation((filter) =>
    lean(filter.email === 'inspector@trustcar.vn' && filter.roleName === 'INSPECTOR' && filter.isActive ? INSPECTOR : null));
  jest.spyOn(Car, 'find').mockImplementation(() => lean([carA, carB]));
  jest.spyOn(Car, 'exists').mockResolvedValue(null);
  jest.spyOn(Car, 'updateOne').mockImplementation(async (filter, update) => {
    carUpdates.push({ filter, update });
    return { modifiedCount: 1 };
  });
  jest.spyOn(InspectionRecord, 'create').mockImplementation(async (docs) => { records.push(...docs); return docs; });
  jest.spyOn(mongoose, 'startSession').mockResolvedValue({
    withTransaction: async (fn) => fn(),
    endSession: async () => {},
  });
});

describe('backfillCpoCertificates', () => {
  test('rejects a missing or non-INSPECTOR account before touching cars', async () => {
    await expect(backfillCpoCertificates({ inspectorEmail: '', log: quiet })).rejects.toThrow('--inspector');
    await expect(backfillCpoCertificates({ inspectorEmail: 'admin@trustcar.vn', log: quiet })).rejects.toThrow('INSPECTOR');
    expect(Car.find).not.toHaveBeenCalled();
  });

  test('selects only active APPROVED_CPO / AVAILABLE cars without a certificate', async () => {
    await backfillCpoCertificates({ inspectorEmail: 'Inspector@TrustCar.vn', log: quiet });

    expect(Car.find.mock.calls[0][0]).toEqual({
      isActive: true, status: { $in: ['APPROVED_CPO', 'AVAILABLE'] }, cpoCertificateId: null,
    });
  });

  test('dry run writes nothing', async () => {
    const result = await backfillCpoCertificates({ inspectorEmail: 'inspector@trustcar.vn', log: quiet });

    expect(result).toEqual({ candidates: 2, certified: 0, skipped: 1 });
    expect(Car.updateOne).not.toHaveBeenCalled();
    expect(InspectionRecord.create).not.toHaveBeenCalled();
  });

  test('apply certifies cars with mileage; record and car share the same code', async () => {
    const result = await backfillCpoCertificates({ inspectorEmail: 'inspector@trustcar.vn', apply: true, log: quiet });

    expect(result).toEqual({ candidates: 2, certified: 1, skipped: 1 });
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({
      carId: carA._id, inspectorId: INSPECTOR._id, submittedBy: INSPECTOR._id,
      status: 'SUBMITTED', result: 'PASSED', odo: 40000,
    });
    expect(record.cpoCertificateId).toMatch(/^CPO-\d{8}-[0-9A-F]{4}$/);
    expect(carUpdates[0].update).toEqual({ $set: { cpoCertificateId: record.cpoCertificateId } });
    expect(carUpdates[0].filter).toMatchObject({ _id: carA._id, cpoCertificateId: null });
  });

  test('a car certified meanwhile is skipped and gets no record', async () => {
    Car.updateOne.mockResolvedValue({ modifiedCount: 0 });

    const result = await backfillCpoCertificates({ inspectorEmail: 'inspector@trustcar.vn', apply: true, log: quiet });

    expect(result.certified).toBe(0);
    expect(records).toHaveLength(0);
  });

  test('the written record gives a MINIMAL public report with the inspector initials', async () => {
    await backfillCpoCertificates({ inspectorEmail: 'inspector@trustcar.vn', apply: true, log: quiet });

    const report = buildPublicReport({ car: carA, record: records[0], inspectorName: INSPECTOR.fullName });

    expect(report).toMatchObject({ level: 'MINIMAL', inspector: 'N.V.A.', certificateId: records[0].cpoCertificateId });
    expect(report.groups.every((g) => g.passed)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('bổ sung');
  });
});
