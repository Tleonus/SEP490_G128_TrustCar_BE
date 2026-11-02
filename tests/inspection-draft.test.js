/**
 * @file inspection-draft.test.js
 * @description Integration tests (real app, in-memory persistence) for creating,
 * saving, reading inspection drafts and issuing upload signatures.
 */

import request from 'supertest';
import { v2 as cloudinary } from 'cloudinary';
import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';

const h = await setupInspectionHarness();
const api = () => request(h.app);
const BASE = '/api/v1/inspections';
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME;
const photo = (inspectionId, name = 'p') =>
  `https://res.cloudinary.com/${CLOUD}/image/upload/v1/trustcar/inspections/${inspectionId}/${name}.jpg`;

let staff;
beforeEach(async () => {
  h.reset();
  staff = await h.loginAs('INSPECTOR');
});

const createDraft = async (carId, who = staff) =>
  api().post(`${BASE}/cars/${carId}/draft`).set('Authorization', who.auth);

describe('POST /inspections/cars/:id/draft', () => {
  test('creates a draft from an INCOMING car, prefilled from the car, and starts the inspection', async () => {
    const carId = h.createCar({ status: 'INCOMING', mileage: 42000 });

    const res = await createDraft(carId);

    expect(res.status).toBe(201);
    const record = res.body.data;
    expect(record).toMatchObject({ status: 'DRAFT', source: 'STAFF', checklistVersion: '1.0' });
    const car = h.car(carId); // Car normalises some fields (e.g. make upper-case)
    expect(record.vehicleInfo.original).toEqual({
      make: car.make, model: car.model, variant: '1.5G', color: 'Trắng', year: 2020, mileage: 42000,
    });
    expect(record.vehicleInfo.confirmed).toEqual(record.vehicleInfo.original);
    expect(record.groups).toHaveLength(5);
    expect(record.groups.flatMap((g) => g.items).every((i) => i.result === null)).toBe(true);
    expect(h.car(carId).status).toBe('UNDER_INSPECTION');
    expect(h.activity.map((a) => a.eventType)).toEqual(['INSPECTION_DRAFT_CREATED', 'CAR_STATUS_CHANGED']);
  });

  test('a second draft for the same car → 409 with the existing draft id', async () => {
    const carId = h.createCar();
    const first = await createDraft(carId);

    const res = await createDraft(carId);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSPECTION_DRAFT_EXISTS');
    expect(res.body.errors[0]).toEqual({ field: 'inspectionId', message: first.body.data._id });
  });

  test.each(['AVAILABLE', 'APPROVED_CPO', 'SOLD'])('car in %s → 400 INVALID_CAR_STATUS', async (status) => {
    const res = await createDraft(h.createCar({ status }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CAR_STATUS');
    expect(h.records.size).toBe(0);
  });

  test('a REJECTED car can be re-inspected; the old submitted record is untouched', async () => {
    const carId = h.createCar({ status: 'REJECTED' });
    const oldId = h.insertRecord({ carId, status: 'SUBMITTED', source: 'STAFF', result: 'FAILED' });
    const before = JSON.stringify(h.record(oldId));

    const res = await createDraft(carId);

    expect(res.status).toBe(201);
    expect(JSON.stringify(h.record(oldId))).toBe(before);
  });

  test('unknown car → 404, malformed id → 422', async () => {
    expect((await createDraft('65f000000000000000000099')).status).toBe(404);
    expect((await createDraft('not-an-id')).status).toBe(422);
  });

  test('a failure while moving the car rolls back the draft', async () => {
    const carId = h.createCar();
    h.failNextCarSaves(1);

    const res = await createDraft(carId);

    expect(res.status).toBe(500);
    expect(h.records.size).toBe(0);
    expect(h.car(carId).status).toBe('INCOMING');
    expect(h.activity).toHaveLength(0);
  });
});

describe('PATCH /inspections/:id', () => {
  let carId;
  let id;
  beforeEach(async () => {
    carId = h.createCar();
    id = (await createDraft(carId)).body.data._id;
  });
  const patch = (body, who = staff) => api().patch(`${BASE}/${id}`).set('Authorization', who.auth).send(body);

  test('replaces only the group sent; other sections keep their values', async () => {
    await patch({ overviewPhotos: { FRONT: photo(id, 'front') } });

    const res = await patch({
      groups: [{ groupKey: 'G1_BODY_FRAME', items: [{ itemKey: 'PILLARS', result: 'PASS' }], photos: [photo(id)] }],
    });

    expect(res.status).toBe(200);
    const g1 = res.body.data.groups.find((g) => g.groupKey === 'G1_BODY_FRAME');
    expect(g1.items).toEqual([{ itemKey: 'PILLARS', result: 'PASS', note: '', photos: [] }]);
    expect(res.body.data.groups.find((g) => g.groupKey === 'G2_FLOOD').items).toHaveLength(5);
    expect(res.body.data.overviewPhotos.FRONT).toBe(photo(id, 'front'));
    expect(String(h.record(id).updatedBy)).toBe(staff.id);
  });

  test('incomplete data can still be saved', async () => {
    const res = await patch({ vehicleInfo: { confirmed: { make: 'Toyota', mileage: null } } });

    expect(res.status).toBe(200);
    expect(res.body.data.vehicleInfo.confirmed).toMatchObject({ make: 'Toyota', mileage: null });
  });

  test.each([
    ['minor defect in the flood group', { groups: [{ groupKey: 'G2_FLOOD', minorDefects: [{ type: 'DENT_MINOR' }] }] }],
    ['unknown item key', { groups: [{ groupKey: 'G1_BODY_FRAME', items: [{ itemKey: 'WINGS' }] }] }],
    ['unknown group key', { groups: [{ groupKey: 'G9' }] }],
    ['note over 1000 characters', { groups: [{ groupKey: 'G1_BODY_FRAME', note: 'x'.repeat(1001) }] }],
    ['year out of range', { vehicleInfo: { confirmed: { year: 1970 } } }],
    ['too many group photos', { groups: [{ groupKey: 'G1_BODY_FRAME', photos: Array(11).fill('https://x.y/a.jpg') }] }],
  ])('%s → 422 VALIDATION_ERROR', async (_label, body) => {
    const res = await patch(body);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  test('photo outside this inspection folder → 422 with the field path', async () => {
    const res = await patch({ overviewPhotos: { FRONT: photo('65f000000000000000000009') } });

    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([expect.objectContaining({ field: 'overviewPhotos.FRONT' })]);
  });

  test('photo with a Cloudinary transformation or a nested folder → 422', async () => {
    const overlay = photo(id).replace('/upload/v1/', '/upload/l_fetch:aHR0cHM6Ly9ldmlsLmNvbS94LmpwZw==/');
    const nested = photo(id).replace('/upload/v1/', '/upload/other/');

    const res = await patch({ overviewPhotos: { FRONT: overlay, REAR: nested } });

    expect(res.status).toBe(422);
    expect(res.body.errors.map((e) => e.field).sort()).toEqual(['overviewPhotos.FRONT', 'overviewPhotos.REAR']);
  });

  test('server-owned fields are ignored', async () => {
    const res = await patch({
      status: 'SUBMITTED',
      cpoCertificateId: 'CPO-20260101-AAAA',
      vehicleInfo: { original: { make: 'Fake' }, confirmed: { make: 'Honda' } },
    });

    expect(res.status).toBe(200);
    expect(h.record(id)).toMatchObject({ status: 'DRAFT', cpoCertificateId: null });
    expect(h.record(id).vehicleInfo.original.make).toBe(h.car(carId).make);
  });

  test('a submitted record is locked → 409 for PATCH and upload signature', async () => {
    h.records.get(id).status = 'SUBMITTED';

    expect((await patch({ vehicleInfo: { confirmed: { make: 'X' } } })).body.code).toBe('INSPECTION_LOCKED');
    const sig = await api().post(`${BASE}/${id}/upload-signature`).set('Authorization', staff.auth);
    expect(sig.status).toBe(409);
  });
});

describe('GET /inspections/:id and upload signature', () => {
  test('returns a draft, and reads a legacy KAN-14 record as SUBMITTED/LEGACY', async () => {
    const carId = h.createCar();
    const id = (await createDraft(carId)).body.data._id;
    const legacyId = h.insertRecord({ carId, result: 'PASSED', odo: 1 });

    const draft = await api().get(`${BASE}/${id}`).set('Authorization', staff.auth);
    const legacy = await api().get(`${BASE}/${legacyId}`).set('Authorization', staff.auth);
    const patchLegacy = await api().patch(`${BASE}/${legacyId}`).set('Authorization', staff.auth)
      .send({ vehicleInfo: { confirmed: { make: 'X' } } });

    expect(draft.body.data.status).toBe('DRAFT');
    expect(legacy.body.data).toMatchObject({ status: 'SUBMITTED', source: 'LEGACY' });
    expect(patchLegacy.status).toBe(409);
    expect((await api().get(`${BASE}/65f000000000000000000099`).set('Authorization', staff.auth)).status).toBe(404);
  });

  test('signature is bound to the draft folder, verifiable and never exposes the secret', async () => {
    const id = (await createDraft(h.createCar())).body.data._id;

    const res = await api().post(`${BASE}/${id}/upload-signature`).set('Authorization', staff.auth);

    expect(res.status).toBe(200);
    const { timestamp, folder, signature, allowedFormats } = res.body.data;
    expect(folder).toBe(`trustcar/inspections/${id}`);
    expect(signature).toBe(cloudinary.utils.api_sign_request(
      { timestamp, folder, allowed_formats: allowedFormats }, process.env.CLOUDINARY_API_SECRET));
    expect(JSON.stringify(res.body)).not.toContain(process.env.CLOUDINARY_API_SECRET);
  });
});

describe('authorization', () => {
  test('CUSTOMER → 403 and no token → 401 on every draft endpoint', async () => {
    const carId = h.createCar();
    const id = (await createDraft(carId)).body.data._id;
    const customer = await h.loginAs('CUSTOMER');
    const calls = [
      (r) => r.post(`${BASE}/cars/${carId}/draft`),
      (r) => r.patch(`${BASE}/${id}`).send({ groups: [] }),
      (r) => r.get(`${BASE}/${id}`),
      (r) => r.post(`${BASE}/${id}/upload-signature`),
    ];

    for (const call of calls) {
      // eslint-disable-next-line no-await-in-loop
      expect((await call(api()).set('Authorization', customer.auth)).status).toBe(403);
      // eslint-disable-next-line no-await-in-loop
      expect((await call(api())).status).toBe(401);
    }
  });

  test('ADMIN can create drafts too', async () => {
    expect((await createDraft(h.createCar(), await h.loginAs('ADMIN'))).status).toBe(201);
  });

  test('SALES_STAFF can read a report but cannot create, edit, sign or submit', async () => {
    const carId = h.createCar();
    const id = (await createDraft(carId)).body.data._id;
    const sales = await h.loginAs('SALES_STAFF');

    expect((await api().get(`${BASE}/${id}`).set('Authorization', sales.auth)).status).toBe(200);
    expect((await createDraft(h.createCar(), sales)).status).toBe(403);
    expect((await api().patch(`${BASE}/${id}`).set('Authorization', sales.auth)
      .send({ vehicleInfo: { confirmed: { make: 'X' } } })).status).toBe(403);
    expect((await api().post(`${BASE}/${id}/upload-signature`).set('Authorization', sales.auth)).status).toBe(403);
    expect((await api().post(`${BASE}/${id}/submit`).set('Authorization', sales.auth)).status).toBe(403);
  });
});
