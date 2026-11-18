/**
 * @file public-inspection-report.test.js
 * @description Integration tests (real app, in-memory persistence) for the public
 * CPO inspection report: GET /api/v1/public/cars/:id/inspection-report.
 */

import request from 'supertest';
import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';
import { getChecklist } from '../src/config/inspectionChecklist.js';

const h = await setupInspectionHarness();
const api = () => request(h.app);
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME;
const CODE = 'CPO-20261102-3F9A';
const allTrue = {
  noMajorAccident: true, noWaterDamage: true, engineGearboxIntact: true, verifiedOdo: true, electricalSystemPassed: true,
};
const img = (folder, name) => `https://res.cloudinary.com/${CLOUD}/image/upload/v1/${folder}/${name}.jpg`;
const report = (idOrCode) => api().get(`/api/v1/public/cars/${idOrCode}/inspection-report`);

let inspector;

/** A certified car with a digital-checklist record (source STAFF). */
const certifiedCar = (carOverrides = {}, recordOverrides = {}) => {
  const carId = h.createCar({ status: 'AVAILABLE', cpoCertificateId: CODE, mileage: 40000, ...carOverrides });
  const recordId = h.insertRecord({
    carId,
    status: 'SUBMITTED',
    source: 'STAFF',
    checklistVersion: '1.0',
    result: 'PASSED',
    cpoCertificateId: CODE,
    criteria: allTrue,
    odo: 50000,
    inspectorId: inspector.id,
    submittedBy: inspector.id,
    submittedAt: new Date('2026-11-02T08:15:00Z'),
    notes: 'Ghi chú nội bộ',
    vehicleInfo: {
      original: { make: 'TOYOTA', mileage: 40000 },
      confirmed: { make: 'TOYOTA', model: 'Vios', variant: '1.5G', color: 'Trắng', year: 2020, mileage: 50000 },
    },
    overviewPhotos: { FRONT: img('trustcar/inspections/r', 'f'), REAR: null, LEFT: null, RIGHT: null },
    groups: getChecklist().map((def) => ({
      groupKey: def.key,
      note: 'nội bộ',
      passed: true,
      items: def.items.map((i) => ({ itemKey: i.key, result: 'PASS', note: '', photos: [] })),
      photos: [img('trustcar/inspections/r', def.key)],
      minorDefects: [],
    })),
    ...recordOverrides,
  });
  return { carId, recordId };
};

beforeEach(async () => {
  h.reset();
  const { id } = await h.createUser({ roleName: 'SALES_STAFF', fullName: 'Nguyễn Văn An' });
  inspector = { id };
});

describe('GET /api/v1/public/cars/:id/inspection-report', () => {
  test('AVAILABLE car with a checklist record → 200 FULL report, no token needed', async () => {
    const { carId } = certifiedCar();

    const res = await report(carId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      certificateId: CODE, level: 'FULL', inspector: 'N.V.A.', issuedAt: '2026-11-02T08:15:00.000Z',
      vehicle: { model: 'Vios', mileage: 50000 },
    });
    expect(res.body.data.groups).toHaveLength(5);
    const json = JSON.stringify(res.body);
    ['Ghi chú nội bộ', 'nội bộ', inspector.id, '"40000"', ':40000'].forEach((s) => expect(json).not.toContain(s));
  });

  test('APPROVED_CPO car (not yet on sale) → 200; lookup by vehicleCode works', async () => {
    const { carId } = certifiedCar({ status: 'APPROVED_CPO', vehicleCode: 'TC-2026-0042' });

    expect((await report(carId)).status).toBe(200);
    const byCode = await report('TC-2026-0042');
    expect(byCode.status).toBe(200);
    expect(byCode.body.data.certificateId).toBe(CODE);
  });

  test('quick-inspection record → MINIMAL report', async () => {
    const { carId } = certifiedCar({}, {
      source: 'ADMIN_QUICK', groups: undefined, vehicleInfo: undefined, overviewPhotos: undefined,
      evidenceImages: [img('trustcar/inspections/quick/c', 'q')],
    });

    const res = await report(carId);

    expect(res.body.data).toMatchObject({ level: 'MINIMAL', overviewPhotos: null, photos: [img('trustcar/inspections/quick/c', 'q')] });
    expect(res.body.data.vehicle.mileage).toBe(50000);
  });

  test.each([
    ['REJECTED car', { status: 'REJECTED' }, {}],
    ['RESERVED car', { status: 'RESERVED' }, {}],
    ['SOLD car', { status: 'SOLD' }, {}],
    ['UNDER_INSPECTION car', { status: 'UNDER_INSPECTION' }, {}],
    ['inactive car', { isActive: false }, {}],
    ['car without certificate', { cpoCertificateId: null }, {}],
    ['record with another certificate', {}, { cpoCertificateId: 'CPO-20260101-0000' }],
    ['record not PASSED', {}, { result: 'FAILED' }],
    ['record still a DRAFT', {}, { status: 'DRAFT' }],
  ])('%s → 404 INSPECTION_REPORT_NOT_FOUND', async (_label, carOverrides, recordOverrides) => {
    const { carId } = certifiedCar(carOverrides, recordOverrides);

    const res = await report(carId);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'INSPECTION_REPORT_NOT_FOUND', message: 'Inspection report not found.' });
  });

  test('unknown id, unknown vehicleCode and garbage id → the same 404', async () => {
    for (const id of ['65f000000000000000000099', 'TC-2099-9999', 'abc$ne']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await report(id);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('INSPECTION_REPORT_NOT_FOUND');
    }
  });

  test('unknown inspector → inspector null', async () => {
    const { carId } = certifiedCar({}, { submittedBy: undefined, inspectorId: '65f0000000000000000000ee' });

    expect((await report(carId)).body.data.inspector).toBeNull();
  });

  test('a token (any role) does not change the report', async () => {
    const { carId } = certifiedCar();
    const customer = await h.loginAs('CUSTOMER');

    const anonymous = await report(carId);
    const withToken = await report(carId).set('Authorization', customer.auth);

    expect(withToken.body).toEqual(anonymous.body);
  });

  test('reads at most 3 documents per request', async () => {
    const { carId } = certifiedCar();
    const spies = [h.Car.findOne, h.InspectionRecord.findOne, h.User.findById];
    spies.forEach((spy) => spy.mockClear());

    await report(carId);

    expect(spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBeLessThanOrEqual(3);
  });
});
