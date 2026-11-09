/**
 * @file inspection-quick.test.js
 * @description Integration tests (real app, in-memory persistence) for the admin
 * quick inspection (5 booleans), sale approval and route mounting.
 */

import request from 'supertest';
import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';

const h = await setupInspectionHarness();
const api = () => request(h.app);
const BASE = '/api/v1/inspections';
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME;
const quickPhoto = (carId, name = 'a') =>
  `https://res.cloudinary.com/${CLOUD}/image/upload/v1/trustcar/inspections/quick/${carId}/${name}.jpg`;

const allTrue = {
  noMajorAccident: true, noWaterDamage: true, engineGearboxIntact: true, verifiedOdo: true, electricalSystemPassed: true,
};

let admin;
beforeEach(async () => {
  h.reset();
  admin = await h.loginAs('ADMIN');
});

const inspect = (carId, body, who = admin) =>
  api().post(`${BASE}/cars/${carId}/inspect`).set('Authorization', who.auth).send(body);

describe('POST /inspections/cars/:id/inspect (admin quick inspection)', () => {
  test('all 5 true → APPROVED_CPO, record SUBMITTED with source ADMIN_QUICK', async () => {
    const carId = h.createCar({ status: 'DRAFT', mileage: 30000 });
    const image = quickPhoto(carId);

    const res = await inspect(carId, { criteria: allTrue, odo: 31000, notes: 'OK', evidenceImages: [image] });

    expect(res.status).toBe(200);
    const { car, inspectionRecord: record } = res.body.data;
    expect(car.status).toBe('APPROVED_CPO');
    expect(record).toMatchObject({
      status: 'SUBMITTED', source: 'ADMIN_QUICK', result: 'PASSED', odo: 31000, evidenceImages: [image],
    });
    expect(record.cpoCertificateId).toBe(car.cpoCertificateId);
    expect(h.car(carId).mileage).toBe(31000);
    expect(h.activity.map((a) => a.eventType)).toEqual(['INSPECTION_SUBMITTED', 'CAR_STATUS_CHANGED']);
  });

  test('one criterion false → REJECTED; a REJECTED car can be quick-inspected again', async () => {
    const carId = h.createCar({ status: 'INCOMING' });

    const first = await inspect(carId, { criteria: { ...allTrue, verifiedOdo: false }, odo: 50000 });
    const again = await inspect(carId, { criteria: allTrue, odo: 50000 });

    expect(first.body.data.car).toMatchObject({ status: 'REJECTED', cpoCertificateId: null });
    expect(again.body.data.car.status).toBe('APPROVED_CPO');
  });

  test.each([
    ['a missing criterion', { criteria: { ...allTrue, verifiedOdo: undefined }, odo: 50000 }],
    ['a non-boolean criterion', { criteria: { ...allTrue, verifiedOdo: 'true' }, odo: 50000 }],
    ['missing odo', { criteria: allTrue }],
    ['negative odo', { criteria: allTrue, odo: -1 }],
    ['an image outside the project cloud', { criteria: allTrue, odo: 50000, evidenceImages: ['https://evil.example.com/a.jpg'] }],
    ['an image of another car', { criteria: allTrue, odo: 50000, evidenceImages: [quickPhoto('65f0000000000000000000bb')] }],
    ['an image with a transformation', { criteria: allTrue, odo: 50000, evidenceImages: ['TRANSFORMED'] }],
  ])('%s → 422 VALIDATION_ERROR', async (_label, body) => {
    const carId = h.createCar();
    const images = (body.evidenceImages || []).map((url) => (url === 'TRANSFORMED'
      ? quickPhoto(carId).replace('/upload/v1/', '/upload/l_text:Arial_80:PASS/v1/')
      : url));

    const res = await inspect(carId, { ...body, ...(body.evidenceImages ? { evidenceImages: images } : {}) });

    expect(res.status).toBe(422);
    expect(h.car(carId).status).toBe('INCOMING');
  });

  test('odo below the stored mileage → 400 MILEAGE_DECREASE, nothing changes', async () => {
    const carId = h.createCar({ mileage: 50000 });

    const res = await inspect(carId, { criteria: allTrue, odo: 49999 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MILEAGE_DECREASE');
    expect(h.records.size).toBe(0);
  });

  test('car with an open checklist draft → 409; car not inspectable → 400', async () => {
    const carId = h.createCar();
    const staff = await h.loginAs('SALES_STAFF');
    await api().post(`${BASE}/cars/${carId}/draft`).set('Authorization', staff.auth);

    expect((await inspect(carId, { criteria: allTrue, odo: 50000 })).body.code).toBe('INSPECTION_DRAFT_EXISTS');
    expect((await inspect(h.createCar({ status: 'AVAILABLE' }), { criteria: allTrue, odo: 50000 })).body.code)
      .toBe('INVALID_CAR_STATUS');
  });

  test('SALES_STAFF must attach at least one photo; with a photo of this car → 200', async () => {
    const inspector = await h.loginAs('SALES_STAFF');
    const carId = h.createCar();

    const without = await inspect(carId, { criteria: allTrue, odo: 50000 }, inspector);
    const withPhoto = await inspect(carId, { criteria: allTrue, odo: 50000, evidenceImages: [quickPhoto(carId)] }, inspector);

    expect(without.status).toBe(400);
    expect(without.body.code).toBe('EVIDENCE_REQUIRED');
    expect(withPhoto.status).toBe(200);
    expect(withPhoto.body.data.inspectionRecord.source).toBe('ADMIN_QUICK');
  });

  test('ADMIN may quick-inspect without photos', async () => {
    expect((await inspect(h.createCar(), { criteria: allTrue, odo: 50000 })).status).toBe(200);
  });

  test.each(['CUSTOMER'])('%s → 403', async (role) => {
    const res = await inspect(h.createCar(), { criteria: allTrue, odo: 50000 }, await h.loginAs(role));

    expect(res.status).toBe(403);
  });
});

describe('POST /inspections/cars/:id/upload-signature', () => {
  const sign = (carId, who) => api().post(`${BASE}/cars/${carId}/upload-signature`).set('Authorization', who.auth);

  test('SALES_STAFF and ADMIN get a signature bound to the car quick folder; secret not exposed', async () => {
    const carId = h.createCar();

    for (const who of [await h.loginAs('SALES_STAFF'), admin]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await sign(carId, who);
      expect(res.status).toBe(200);
      expect(res.body.data.folder).toBe(`trustcar/inspections/quick/${carId}`);
      expect(JSON.stringify(res.body)).not.toContain(process.env.CLOUDINARY_API_SECRET);
    }
  });

  test('CUSTOMER → 403; car not inspectable → 400; unknown car → 404', async () => {
    const carId = h.createCar();

    // KAN-54: SALES_STAFF is now a writer — only CUSTOMER is forbidden
    expect((await sign(carId, await h.loginAs('CUSTOMER'))).status).toBe(403);
    expect((await sign(h.createCar({ status: 'AVAILABLE' }), admin)).body.code).toBe('INVALID_CAR_STATUS');
    expect((await sign('65f000000000000000000099', admin)).status).toBe(404);
  });
});

describe('PUT /inspections/cars/:id/approve-sale and routing', () => {
  test('approve-sale still moves an APPROVED_CPO car to AVAILABLE', async () => {
    const carId = h.createCar({ status: 'APPROVED_CPO', cpoCertificateId: 'CPO-20261102-ABCD' });

    const res = await api().put(`${BASE}/cars/${carId}/approve-sale`).set('Authorization', admin.auth);

    expect(res.status).toBe(200);
    expect(h.car(carId).status).toBe('AVAILABLE');
  });

  test('the inspection router answers under /api/v1/inspections (401 without token)', async () => {
    expect((await api().get(`${BASE}/65f000000000000000000099`)).status).toBe(401);
  });
});
