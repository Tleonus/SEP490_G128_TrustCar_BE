import { expect, jest, test } from '@jest/globals';
import { CarStatus, InspectionSource, InspectionStatus } from '../src/constants/appConstants.js';
import { CPO_CRITERIA } from '../src/domain/inspection/criteria.js';
import { createGetInspectionReport } from '../src/usecase/inspection-report/getInspectionReport.js';

const carId = 'abcdef000000000000000001';
const inspectorId = 'abcdef000000000000000002';
const submitterId = 'abcdef000000000000000003';
const vehicleCode = 'TC-2026-0001';
const certificate = 'CPO-20261123-AB12';
const issuedAt = '2026-11-23T10:00:00.000Z';
const vehicle = { make: 'VinFast', model: 'VF 8', variant: 'Eco', color: 'Blue', year: 2024, mileage: 9000 };
const confirmedVehicle = { ...vehicle, color: 'White', mileage: 8000 };
const passed = Object.fromEntries(CPO_CRITERIA.map(({ criteriaKey }) => [criteriaKey, true]));
const groups = CPO_CRITERIA.map(({ key, label }) => ({ key, label, passed: true }));
const car = { ...vehicle, id: carId, isActive: true, status: CarStatus.APPROVED_CPO, cpoCertificateId: certificate };
const record = {
  carId, cpoCertificateId: certificate, status: InspectionStatus.SUBMITTED, source: InspectionSource.STAFF,
  result: 'PASSED', submittedAt: new Date(issuedAt), submittedBy: submitterId, inspectorId,
  criteria: passed, confirmedVehicle, odo: 7500,
};
const missing = {
  statusCode: 404, code: 'INSPECTION_REPORT_NOT_FOUND', message: 'Inspection report not found.',
};

function fixture({ storedCar = car, storedRecord = record, storedName = 'Nguyễn Văn An' } = {}) {
  const reader = {
    findCar: jest.fn(async () => storedCar),
    findCertifyingInspection: jest.fn(async () => storedRecord),
    findInspectorName: jest.fn(async () => storedName),
  };
  return { reader, getReport: createGetInspectionReport({ reader }) };
}

test.each([CarStatus.APPROVED_CPO, CarStatus.AVAILABLE])('reads a full report for an active %s car', async (status) => {
  const { reader, getReport } = fixture({ storedCar: { ...car, status } });
  expect(await getReport(carId.toUpperCase())).toEqual({
    certificateId: certificate, issuedAt, level: 'FULL', inspector: 'N.V.A.', vehicle: confirmedVehicle, groups,
  });
  expect(reader.findCar).toHaveBeenCalledTimes(1);
  expect(reader.findCar).toHaveBeenCalledWith({ kind: 'id', value: carId });
  expect(reader.findCertifyingInspection).toHaveBeenCalledTimes(1);
  expect(reader.findCertifyingInspection).toHaveBeenCalledWith(carId, certificate);
  expect(reader.findInspectorName).toHaveBeenCalledTimes(1);
  expect(reader.findInspectorName).toHaveBeenCalledWith(submitterId);
});

test('looks up the exact canonical vehicle code and uses the inspection odometer for a quick report', async () => {
  const { reader, getReport } = fixture({
    storedRecord: { ...record, source: InspectionSource.ADMIN_QUICK, submittedBy: undefined },
  });
  expect(await getReport(vehicleCode)).toEqual({
    certificateId: certificate, issuedAt, level: 'MINIMAL', inspector: 'N.V.A.',
    vehicle: { ...vehicle, mileage: 7500 }, groups,
  });
  expect(reader.findCar).toHaveBeenCalledWith({ kind: 'vehicleCode', value: vehicleCode });
  expect(reader.findInspectorName).toHaveBeenCalledWith(inspectorId);
});

test('uses createdAt and inspectorId for a legacy record', async () => {
  const { reader, getReport } = fixture({
    storedRecord: {
      ...record, source: undefined, status: undefined, submittedAt: undefined, submittedBy: undefined,
      createdAt: '2026-11-23T17:10:00+07:00',
    },
    storedName: '  Nguye\u0302\u0303n\t Văn  An  ',
  });
  expect(await getReport(carId)).toEqual({
    certificateId: certificate, issuedAt: '2026-11-23T10:10:00.000Z', level: 'MINIMAL',
    inspector: 'N.V.A.', vehicle: { ...vehicle, mileage: record.odo }, groups,
  });
  expect(reader.findInspectorName).toHaveBeenCalledWith(inspectorId);
});

test('keeps only saved own booleans that are strictly true in the fixed order', async () => {
  const criteria = Object.assign(Object.create({ noWaterDamage: true }), {
    electricalSystemPassed: true,
    noMajorAccident: true,
    engineGearboxIntact: 'true',
    verifiedOdo: false,
    extra: true,
  });
  const { getReport } = fixture({
    storedRecord: {
      ...record, criteria,
      groups: [{ key: CPO_CRITERIA[2].key, passed: true }],
      templateSnapshot: { groups: [{ key: CPO_CRITERIA[0].key, label: 'Edited template label' }] },
    },
  });
  expect((await getReport(carId)).groups).toEqual([groups[0], groups[4]]);
});

test('does not output internal references, evidence, notes or arbitrary nested properties', async () => {
  const { getReport } = fixture({
    storedRecord: {
      ...record,
      _id: 'private-record-id', notes: 'private note', photos: ['private photo'],
      answers: [{ value: 'private answer' }], archivedAnswers: [{ value: 'private history' }],
      confirmedVehicle: { ...confirmedVehicle, color: { description: 'private data' }, vin: 'private VIN' },
    },
    storedCar: { ...car, vin: 'private VIN', ownerPhone: 'private phone' },
  });
  expect(await getReport(carId)).toEqual({
    certificateId: certificate, issuedAt, level: 'FULL', inspector: 'N.V.A.',
    vehicle: { ...confirmedVehicle, color: null }, groups,
  });
});

test.each([null, '', '  '])('uses null for a missing or blank inspector name', async (storedName) => {
  const { reader, getReport } = fixture({ storedName });
  expect((await getReport(carId)).inspector).toBeNull();
  expect(reader.findInspectorName).toHaveBeenCalledTimes(1);
});

test('skips the name read when the record has no inspector reference', async () => {
  const { reader, getReport } = fixture({
    storedRecord: { ...record, submittedBy: null, inspectorId: null, submittedAt: 'bad date', createdAt: null },
  });
  expect(await getReport(carId)).toMatchObject({ inspector: null, issuedAt: null });
  expect(reader.findInspectorName).not.toHaveBeenCalled();
});

test.each(['random-key', 'TC-2026-001', 'TC-2026-0001\n', '', null, { id: carId }])(
  'returns the same not-found response for invalid lookup %p without reading', async (key) => {
    const { reader, getReport } = fixture();
    await expect(getReport(key)).rejects.toMatchObject(missing);
    expect(reader.findCar).not.toHaveBeenCalled();
  },
);

test.each([
  null, { ...car, isActive: false }, { ...car, isActive: undefined },
  { ...car, status: CarStatus.REJECTED }, { ...car, status: CarStatus.RESERVED },
  { ...car, status: CarStatus.SOLD }, { ...car, status: CarStatus.UNDER_INSPECTION },
  { ...car, cpoCertificateId: null }, { ...car, cpoCertificateId: ' ' },
])('returns the same not-found response for an ineligible car', async (storedCar) => {
  const { reader, getReport } = fixture({ storedCar });
  await expect(getReport(carId)).rejects.toMatchObject(missing);
  expect(reader.findCertifyingInspection).not.toHaveBeenCalled();
  expect(reader.findInspectorName).not.toHaveBeenCalled();
});

test.each([
  null, { ...record, cpoCertificateId: 'unmatched' }, { ...record, carId: inspectorId },
  { ...record, status: InspectionStatus.PENDING_APPROVAL }, { ...record, status: InspectionStatus.DRAFT },
  { ...record, result: 'FAILED' }, { ...record, status: '' },
])('returns the same not-found response for an ineligible inspection', async (storedRecord) => {
  const { reader, getReport } = fixture({ storedRecord });
  await expect(getReport(vehicleCode)).rejects.toMatchObject(missing);
  expect(reader.findInspectorName).not.toHaveBeenCalled();
});

test('lets an unexpected persistence failure reach the outer error handler', async () => {
  const { reader, getReport } = fixture();
  const failure = new Error('Read failed');
  reader.findCar.mockRejectedValueOnce(failure);
  await expect(getReport(carId)).rejects.toBe(failure);
});
