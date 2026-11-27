import request from 'supertest';
import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';

const h = await setupInspectionHarness();
const api = () => request(h.app);
const BASE = '/api/v1/inspections';

let staff;
let writer;
let admin;
let carId;
let id;

const fillDraft = (confirmed = {}) => h.fillDraft(id, { mileage: 50000, ...confirmed });
const submit = (who = writer, body = { baseRevision: 1 }, recordId = id) =>
  api().post(`${BASE}/${recordId}/submit`).set('Authorization', who.auth).send(body);

beforeEach(async () => {
  h.reset();
  staff = await h.loginAs('SALES_STAFF');
  writer = await h.loginAs('INSPECTOR');
  admin = await h.loginAs('ADMIN');
  carId = h.createCar({ status: 'INCOMING', mileage: 48000 });
  const created = await api().post(`${BASE}/cars/${carId}/draft`).set('Authorization', writer.auth).expect(201);
  id = created.body.data._id;
  h.activity.length = 0;
});

test('an inspector submits all PASS and the system issues one matching certificate and publishes the car', async () => {
  fillDraft();
  const res = await submit().expect(200);
  const { car, inspectionRecord: record } = res.body.data;
  expect(car).toMatchObject({ status: 'AVAILABLE', listedDate: expect.any(String) });
  expect(record.cpoCertificateId).toMatch(/^CPO-\d{8}-[0-9A-F]{4}$/);
  expect(car.cpoCertificateId).toBe(record.cpoCertificateId);
  expect(record).toMatchObject({
    _id: id, status: 'SUBMITTED', source: 'STAFF', result: 'PASSED', odo: 50000, submittedBy: writer.id,
    checklistSnapshot: { templateKey: 'GASOLINE', revision: 1 },
  });
  expect(record.approvedBy).toBeUndefined();
  expect(Object.values(record.criteria).every((value) => value === true)).toBe(true);
  expect(record.groups.every((group) => group.passed)).toBe(true);
  expect(record.notes).toContain('Thân vỏ tốt');
  expect(record.evidenceImages).toHaveLength(10);
  expect(h.car(carId).mileage).toBe(50000);
  expect(h.activity.map((entry) => entry.eventType)).toEqual([
    'INSPECTION_SUBMITTED', 'CAR_STATUS_CHANGED',
  ]);
  await api().get(`/api/v1/public/cars/${carId}/inspection-report`).expect(200);
});

test('NOT_CHECKABLE with a reason leads to REJECTED on submission', async () => {
  const raw = fillDraft();
  raw.answers[2].value = 'unchecked';
  raw.groups[2].note = 'Hết ắc quy';

  const res = await submit().expect(200);
  expect(res.body.data.car).toMatchObject({ status: 'REJECTED', cpoCertificateId: null });
  expect(res.body.data.inspectionRecord).toMatchObject({
    result: 'FAILED', cpoCertificateId: null, criteria: { engineGearboxIntact: false },
  });
});

test('reports every violation together and keeps the saved draft', async () => {
  const raw = fillDraft();
  raw.overviewPhotos.REAR = null;
  raw.groups[3].odometerPhoto = null;
  raw.answers[0].value = 'fail';
  raw.groups[0].note = '';
  raw.groups[0].photos = [];
  const before = JSON.stringify(raw);

  const res = await submit().expect(400);
  expect(res.body.code).toBe('INSPECTION_INCOMPLETE');
  expect(res.body.errors.map(({ field }) => field)).toEqual(expect.arrayContaining([
    'overviewPhotos.REAR', 'groups.3.odometerPhoto', 'groups.0.photos', 'groups.0.note',
  ]));
  expect(JSON.stringify(h.record(id))).toBe(before);
  expect(h.car(carId).status).toBe('UNDER_INSPECTION');
});

test('rejects changes in the submit body before writing the draft', async () => {
  fillDraft();
  const before = JSON.stringify(h.record(id));
  const res = await submit(writer, { baseRevision: 1, answers: [], vehicleInfo: { confirmed: { mileage: 1 } } }).expect(422);
  expect(res.body.code).toBe('VALIDATION_ERROR');
  expect(JSON.stringify(h.record(id))).toBe(before);
  expect(h.activity).toHaveLength(0);
});

test('actual mileage below the stored mileage yields MILEAGE_DECREASE', async () => {
  fillDraft({ mileage: 47000 });
  const res = await submit().expect(400);
  expect(res.body.errors.map(({ code }) => code)).toContain('MILEAGE_DECREASE');
});

test('equal mileage keeps the stored mileage through finalization', async () => {
  fillDraft({ mileage: 48000 });
  await submit().expect(200);
  expect(h.car(carId).mileage).toBe(48000);
});

test('submission locks PATCH, resubmission and signing for writers', async () => {
  fillDraft();
  await submit().expect(200);

  expect((await submit().expect(409)).body.code).toBe('INSPECTION_LOCKED');
  await api().patch(`${BASE}/${id}`).set('Authorization', writer.auth)
    .send({ baseRevision: 1, vehicleInfo: { confirmed: { make: 'X' } } }).expect(409);
  await api().post(`${BASE}/${id}/upload-signature`).set('Authorization', writer.auth).expect(409);
});

test('two concurrent submits issue a single certificate and one car status change', async () => {
  fillDraft();
  const results = await Promise.all([submit(), submit()]);
  expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
  expect(h.record(id).status).toBe('SUBMITTED');
  expect(h.car(carId).cpoCertificateId).toEqual(expect.any(String));
  expect(h.record(id).cpoCertificateId).toBe(h.car(carId).cpoCertificateId);
  expect(h.activity.filter((entry) => entry.eventType === 'INSPECTION_SUBMITTED')).toHaveLength(1);
  expect(h.activity.filter((entry) => entry.eventType === 'CAR_STATUS_CHANGED')).toHaveLength(1);
});

test('admin and sales alone cannot submit; the previous approval route is retired', async () => {
  fillDraft();
  await submit(admin).expect(403);
  await submit(staff).expect(403);
  await api().post(`${BASE}/${id}/approve`).set('Authorization', admin.auth).expect(404);
  expect(h.record(id).status).toBe('DRAFT');
  expect(h.car(carId).cpoCertificateId).toBeNull();
});

test('record write failure leaves the saved draft and car intact', async () => {
  fillDraft();
  h.failNextInspectionUpdate();
  await submit().expect(500);
  expect(h.record(id).status).toBe('DRAFT');
  expect(h.car(carId)).toMatchObject({ status: 'UNDER_INSPECTION', cpoCertificateId: null, mileage: 48000 });
  expect(h.activity).toHaveLength(0);
});

test('car write failure rolls submission back to draft', async () => {
  fillDraft();
  h.failNextCarSaves(1);
  await submit().expect(500);
  expect(h.record(id).status).toBe('DRAFT');
  expect(h.car(carId)).toMatchObject({ status: 'UNDER_INSPECTION', cpoCertificateId: null, mileage: 48000 });
  expect(h.activity).toHaveLength(0);
});

test.each([[2, 200, 'SUBMITTED'], [3, 500, 'DRAFT']])(
  'submit handles %i certificate collisions', async (collisions, httpStatus, status) => {
    fillDraft();
    h.forceCpoCollisions(collisions);
    const res = await submit().expect(httpStatus);
    expect(h.record(id).status).toBe(status);
    if (httpStatus === 500) {
      expect(res.body.code).toBe('CPO_CODE_GENERATION_FAILED');
      expect(h.car(carId).status).toBe('UNDER_INSPECTION');
    }
  },
);

test('rejects submission if the car left UNDER_INSPECTION', async () => {
  fillDraft();
  h.car(carId).status = 'DELISTED';
  const res = await submit().expect(409);
  expect(res.body.code).toBe('INVALID_CAR_STATUS');
});

test('CUSTOMER cannot submit and unknown records return 404', async () => {
  await submit(await h.loginAs('CUSTOMER')).expect(403);
  await submit(writer, { baseRevision: 1 }, '65f000000000000000000099').expect(404);
});
