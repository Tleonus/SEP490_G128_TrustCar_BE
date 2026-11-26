import { expect, jest, test } from '@jest/globals';
import mongoose from 'mongoose';
import { CarStatus, InspectionSource, InspectionStatus } from '../src/constants/appConstants.js';
import { createInspectionReportRepository } from '../src/infra/inspection-report/inspectionReportRepository.js';
import { createGetInspectionReport } from '../src/usecase/inspection-report/getInspectionReport.js';

const carId = '64a713000000000000000001';
const submitterId = '64a713000000000000000002';
const inspectorId = '64a713000000000000000003';
const vehicleCode = 'TC-2026-0042';
const certificateId = 'CPO-2026-0042';
const submittedAt = new Date('2026-10-01T07:30:00Z');
const createdAt = new Date('2026-10-01T07:10:00Z');

const car = {
  _id: new mongoose.Types.ObjectId(carId),
  isActive: true,
  status: CarStatus.AVAILABLE,
  cpoCertificateId: certificateId,
  make: 'Toyota', model: 'Vios', variant: 'G', year: 2021,
  specifications: { color: 'Đỏ', otherDetail: 'internal' },
  vin: 'private', price: 500000000, mileage: 23000,
};

const record = {
  carId: new mongoose.Types.ObjectId(carId),
  cpoCertificateId: certificateId,
  status: InspectionStatus.SUBMITTED,
  source: InspectionSource.STAFF,
  result: 'PASSED',
  odo: 20000,
  criteria: { noMajorAccident: true, noWaterDamage: false, internalResult: true },
  vehicleInfo: {
    original: { color: 'Đỏ', vin: 'private' },
    confirmed: { make: 'Toyota', model: 'Vios', variant: 'G', color: 'Xanh', year: 2021, mileage: 21000, vin: 'private' },
  },
  submittedAt,
  createdAt,
  submittedBy: new mongoose.Types.ObjectId(submitterId),
  inspectorId: new mongoose.Types.ObjectId(inspectorId),
  groups: [{ internalNote: 'private' }],
};

function setup({ carDocument = car, recordDocument = record, userDocument = { fullName: 'Đỗ Văn An', email: 'private' } } = {}) {
  const carQuery = { lean: jest.fn().mockResolvedValue(carDocument) };
  const recordQuery = { lean: jest.fn().mockResolvedValue(recordDocument) };
  recordQuery.sort = jest.fn().mockReturnValue(recordQuery);
  const userQuery = { lean: jest.fn().mockResolvedValue(userDocument) };
  const carModel = { findOne: jest.fn().mockReturnValue(carQuery) };
  const recordModel = { findOne: jest.fn().mockReturnValue(recordQuery) };
  const userModel = { findById: jest.fn().mockReturnValue(userQuery) };
  const reader = createInspectionReportRepository({ carModel, recordModel, userModel });
  return { reader, carModel, recordModel, userModel, carQuery, recordQuery, userQuery };
}

test.each([
  [{ kind: 'id', value: carId }, { _id: carId }],
  [{ kind: 'vehicleCode', value: vehicleCode }, { vehicleCode }],
])('uses the exact car lookup and report projection for %j', async (lookup, filter) => {
  const { reader, carModel, carQuery } = setup();

  await expect(reader.findCar(lookup)).resolves.toStrictEqual({
    id: carId, isActive: true, status: CarStatus.AVAILABLE, cpoCertificateId: certificateId,
    make: 'Toyota', model: 'Vios', variant: 'G', year: 2021, color: 'Đỏ',
  });
  expect(carModel.findOne).toHaveBeenCalledTimes(1);
  expect(carModel.findOne).toHaveBeenCalledWith({
    ...filter, isActive: true, status: { $in: [CarStatus.APPROVED_CPO, CarStatus.AVAILABLE] },
    cpoCertificateId: { $ne: null },
  }, {
    _id: 1, isActive: 1, status: 1, cpoCertificateId: 1,
    make: 1, model: 1, variant: 1, year: 1, 'specifications.color': 1,
  });
  expect(carQuery.lean).toHaveBeenCalledTimes(1);
});

test('queries only passing and finalized or legacy records and selects the newest match', async () => {
  const { reader, recordModel, recordQuery } = setup();

  await expect(reader.findCertifyingInspection(carId, certificateId)).resolves.toStrictEqual({
    carId, cpoCertificateId: certificateId, status: InspectionStatus.SUBMITTED, source: InspectionSource.STAFF,
    result: 'PASSED', criteria: { noMajorAccident: true, noWaterDamage: false },
    confirmedVehicle: { make: 'Toyota', model: 'Vios', variant: 'G', color: 'Xanh', year: 2021, mileage: 21000 },
    odo: 20000, submittedAt, createdAt, submittedBy: submitterId, inspectorId,
  });
  expect(recordModel.findOne).toHaveBeenCalledTimes(1);
  expect(recordModel.findOne).toHaveBeenCalledWith({
    carId, cpoCertificateId: certificateId, result: 'PASSED',
    $or: [{ status: InspectionStatus.SUBMITTED }, { status: null }],
  }, {
    _id: 1, carId: 1, cpoCertificateId: 1, status: 1, source: 1, result: 1,
    odo: 1, submittedAt: 1, createdAt: 1, submittedBy: 1, inspectorId: 1,
    templateKey: 1, checklistVersion: 1, 'checklistSnapshot.revision': 1,
    'criteria.noMajorAccident': 1,
    'criteria.noWaterDamage': 1,
    'criteria.engineGearboxIntact': 1,
    'criteria.verifiedOdo': 1,
    'criteria.electricalSystemPassed': 1,
    'vehicleInfo.confirmed.make': 1,
    'vehicleInfo.confirmed.model': 1,
    'vehicleInfo.confirmed.variant': 1,
    'vehicleInfo.confirmed.color': 1,
    'vehicleInfo.confirmed.year': 1,
    'vehicleInfo.confirmed.mileage': 1,
  });
  expect(recordQuery.sort).toHaveBeenCalledTimes(1);
  expect(recordQuery.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
  expect(recordQuery.lean).toHaveBeenCalledTimes(1);
});

test.each([undefined, null])('keeps legacy status %s and tolerates missing optional fields', async (status) => {
  const { reader } = setup({ recordDocument: { carId, cpoCertificateId: certificateId, result: 'PASSED', status } });
  await expect(reader.findCertifyingInspection(carId, certificateId)).resolves.toStrictEqual({
    carId, cpoCertificateId: certificateId, result: 'PASSED', status,
    source: undefined, criteria: {}, confirmedVehicle: null, odo: undefined,
    submittedAt: undefined, createdAt: undefined, submittedBy: null, inspectorId: null,
  });
});

test('reads only the selected user full name', async () => {
  const { reader, userModel, userQuery } = setup();
  await expect(reader.findInspectorName(submitterId)).resolves.toBe('Đỗ Văn An');
  expect(userModel.findById).toHaveBeenCalledTimes(1);
  expect(userModel.findById).toHaveBeenCalledWith(submitterId, { _id: 0, fullName: 1 });
  expect(userQuery.lean).toHaveBeenCalledTimes(1);
});

test('returns null if any of the three reads misses', async () => {
  const { reader } = setup({ carDocument: null, recordDocument: null, userDocument: null });
  await expect(reader.findCar({ kind: 'id', value: carId })).resolves.toBeNull();
  await expect(reader.findCertifyingInspection(carId, certificateId)).resolves.toBeNull();
  await expect(reader.findInspectorName(inspectorId)).resolves.toBeNull();
});

test('rejects invalid lookup and non-string selectors before reading MongoDB', async () => {
  const { reader, carModel, recordModel, userModel } = setup();

  await expect(reader.findCar({ kind: 'id', value: { $ne: null } })).resolves.toBeNull();
  await expect(reader.findCar({ kind: 'id', value: 'invalid' })).resolves.toBeNull();
  await expect(reader.findCar({ kind: 'vehicleCode', value: vehicleCode + '\n' })).resolves.toBeNull();
  await expect(reader.findCar({ kind: 'unknown', value: carId })).resolves.toBeNull();
  await expect(reader.findCertifyingInspection('invalid', certificateId)).resolves.toBeNull();
  await expect(reader.findCertifyingInspection(carId, { $ne: null })).resolves.toBeNull();
  await expect(reader.findCertifyingInspection(carId, ' ')).resolves.toBeNull();
  await expect(reader.findInspectorName({ $ne: null })).resolves.toBeNull();
  expect(carModel.findOne).not.toHaveBeenCalled();
  expect(recordModel.findOne).not.toHaveBeenCalled();
  expect(userModel.findById).not.toHaveBeenCalled();
});

test('builds a report in three reads and uses one name lookup when both references exist', async () => {
  const { reader, carModel, recordModel, userModel } = setup();
  const getInspectionReport = createGetInspectionReport({ reader });

  await expect(getInspectionReport(vehicleCode)).resolves.toMatchObject({
    certificateId, level: 'FULL', inspector: 'Đ.V.A.', vehicle: { color: 'Xanh', mileage: 21000 },
    groups: [{ key: 'G1_BODY_FRAME', passed: true }],
  });
  expect(carModel.findOne).toHaveBeenCalledTimes(1);
  expect(recordModel.findOne).toHaveBeenCalledTimes(1);
  expect(userModel.findById).toHaveBeenCalledTimes(1);
  expect(userModel.findById).toHaveBeenCalledWith(submitterId, { _id: 0, fullName: 1 });
});

test.each([
  [{ carDocument: null }, 0],
  [{ recordDocument: null }, 1],
])('stops reading after a missing car or certificate: %j', async (documents, recordReads) => {
  const { reader, carModel, recordModel, userModel } = setup(documents);
  const getInspectionReport = createGetInspectionReport({ reader });

  await expect(getInspectionReport(carId)).rejects.toMatchObject({ code: 'INSPECTION_REPORT_NOT_FOUND', statusCode: 404 });
  expect(carModel.findOne).toHaveBeenCalledTimes(1);
  expect(recordModel.findOne).toHaveBeenCalledTimes(recordReads);
  expect(userModel.findById).not.toHaveBeenCalled();
});

test('uses two reads for a legacy certificate without valid inspector references', async () => {
  const { reader, carModel, recordModel, userModel } = setup({
    recordDocument: { ...record, status: undefined, source: undefined, submittedBy: 'invalid', inspectorId: null },
  });
  const getInspectionReport = createGetInspectionReport({ reader });

  await expect(getInspectionReport(carId)).resolves.toMatchObject({
    certificateId, level: 'MINIMAL', inspector: null, vehicle: { color: 'Đỏ', mileage: 20000 },
  });
  expect(carModel.findOne).toHaveBeenCalledTimes(1);
  expect(recordModel.findOne).toHaveBeenCalledTimes(1);
  expect(userModel.findById).not.toHaveBeenCalled();
});
