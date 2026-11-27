import request from 'supertest';
import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';

const h = await setupInspectionHarness();
const base = '/api/v1/inspections';
const previousCode = 'CPO-20261126-ORIGINAL';
const previousHash = '0123456789abcdef01234567';
const odo = 51_000;
let inspector;
let admin;
let groups;

beforeEach(async () => {
  h.reset();
  groups = h.useCriteriaTemplate();
  inspector = await h.loginAs('INSPECTOR');
  admin = await h.loginAs('ADMIN');
});

const api = () => request(h.app);
const create = (carId) => api().post(`${base}/cars/${carId}/draft`).set('Authorization', inspector.auth);
const get = (id) => api().get(`${base}/${id}`).set('Authorization', inspector.auth);
const save = (id, data) => api().patch(`${base}/${id}`).set('Authorization', inspector.auth)
  .send({ baseRevision: 2, ...data });
const submit = (id) => api().post(`${base}/${id}/submit`).set('Authorization', inspector.auth)
  .send({ baseRevision: 2 });
const results = (outcome = 'PASS') => groups.map(({ key }) => ({
  criterionId: key, outcome: key === 'G6_BODYWORK' ? outcome : 'PASS',
}));
const listedCar = () => h.createCar({
  status: 'AVAILABLE', mileage: 50_000, cpoCertificateId: previousCode, historyVerifyHash: previousHash,
});

async function open(carId) {
  const response = await create(carId).expect(201);
  return response.body.data._id;
}

test('creates and finalizes a compact inspection without legacy fields, using the saved revision after head changes', async () => {
  const carId = h.createCar({ status: 'INCOMING', mileage: 50_000 });
  const id = await open(carId);
  expect(h.car(carId).status).toBe('UNDER_INSPECTION');
  expect(h.records.get(id)).toMatchObject({ status: 'DRAFT', checklistVersion: '2' });
  for (const field of ['vehicleInfo', 'answers', 'groups', 'criteria', 'checklistSnapshot', 'notes', 'evidenceImages']) {
    expect(h.records.get(id)).not.toHaveProperty(field);
  }

  const incomplete = await submit(id).expect(400);
  expect(incomplete.body.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'results.G6_BODYWORK' }),
    expect.objectContaining({ field: 'odo' }),
  ]));

  h.useCriteriaTemplate(3);
  const mismatched = await save(id, { baseRevision: 3, odo, results: results() }).expect(409);
  expect(mismatched.body.code).toBe('FORM_REVISION_CONFLICT');
  await save(id, {
    odo, results: [{ ...results()[0], evidenceImages: ['https://example.test/unrelated.jpg'] }],
  }).expect(422);
  expect((await get(id).expect(200)).body.data.results).toEqual([]);
  const { body: saved } = await save(id, { odo, results: results() }).expect(200);
  expect(saved.data.results).toHaveLength(groups.length);
  expect(saved.data.template).toMatchObject({ format: 'CRITERIA', revision: 2 });
  expect(saved.data).toMatchObject({ odo, templateRevision: 2 });
  const opened = await api().get(`${base}/cars/${carId}`).set('Authorization', inspector.auth).expect(200);
  expect(opened.body.data.openInspection).toMatchObject({ _id: id, status: 'DRAFT' });

  const { body: verdict } = await submit(id).expect(200);
  await save(id, { odo: 52_000 }).expect(409);
  expect(verdict.data.inspectionRecord).toMatchObject({ result: 'PASSED', status: 'SUBMITTED', odo, templateRevision: 2 });
  expect(verdict.data.car).toMatchObject({ status: 'AVAILABLE', mileage: odo, cpoCertificateId: expect.any(String),
    listedDate: expect.any(String) });
  expect(h.records.get(id)).not.toHaveProperty('checklistSnapshot');
  expect(h.records.get(id)).not.toHaveProperty('criteria');
  expect((await get(id).expect(200)).body.data.results).toHaveLength(groups.length);
  const certificate = await api().get(`${base}/certificates/${carId}`).set('Authorization', inspector.auth).expect(200);
  expect(certificate.body.data).toMatchObject({ templateRevision: 2, inspectionId: id,
    verificationPath: expect.stringMatching(/^\/verify\/[a-f\d]{24}$/) });
  await submit(id).expect(409);
});

test('renews a listed car certificate on passing submission, preserving the selling status', async () => {
  const carId = listedCar();
  const id = await open(carId);
  await save(id, { odo, results: results() }).expect(200);
  expect(h.car(carId)).toMatchObject({ status: 'AVAILABLE', cpoCertificateId: previousCode, historyVerifyHash: previousHash });
  const { body } = await submit(id).expect(200);
  expect(body.data.car.status).toBe('AVAILABLE');
  expect(body.data.car.cpoCertificateId).not.toBe(previousCode);
  expect(body.data.inspectionRecord.cpoCertificateId).toBe(body.data.car.cpoCertificateId);
  expect(body.data.car.historyVerifyHash).not.toBe(previousHash);
  expect(h.activity).toContainEqual(expect.objectContaining({
    eventType: 'CAR_UPDATED', changes: {
      before: { cpoCertificateId: previousCode }, after: { cpoCertificateId: body.data.car.cpoCertificateId },
    },
  }));
});

test.each(['FAIL', 'NOT_CHECKABLE'])('keeps the previous certificate when a required result is %s', async (outcome) => {
  const carId = listedCar();
  const id = await open(carId);
  await save(id, { odo, results: results(outcome) }).expect(200);
  const { body } = await submit(id).expect(200);
  expect(body.data.inspectionRecord).toMatchObject({ result: 'FAILED', cpoCertificateId: null });
  expect(h.car(carId)).toMatchObject({
    status: 'AVAILABLE', mileage: 50_000, cpoCertificateId: previousCode, historyVerifyHash: previousHash,
  });
});

test('refuses renewal when the car becomes reserved before submission', async () => {
  const carId = listedCar();
  const id = await open(carId);
  await save(id, { odo, results: results() }).expect(200);
  h.cars.get(carId).status = 'RESERVED';
  const response = await submit(id).expect(409);
  expect(response.body.code).toBe('INVALID_CAR_STATUS');
  expect(h.records.get(id).status).toBe('DRAFT');
  expect(h.car(carId)).toMatchObject({ status: 'RESERVED', cpoCertificateId: previousCode, historyVerifyHash: previousHash });
});

test('rolls back the finalized inspection if the car update cannot match its status and certificate', async () => {
  const carId = listedCar();
  const id = await open(carId);
  await save(id, { odo, results: results() }).expect(200);
  h.Car.findOneAndUpdate.mockReturnValueOnce({ lean: async () => null });
  await submit(id).expect(409);
  expect(h.Car.findOneAndUpdate.mock.calls.at(-1)[0]).toMatchObject({
    status: 'AVAILABLE', cpoCertificateId: previousCode,
  });
  expect(h.records.get(id)).toMatchObject({ status: 'DRAFT', cpoCertificateId: null });
  expect(h.car(carId)).toMatchObject({ cpoCertificateId: previousCode, historyVerifyHash: previousHash });
});

test('returns a criteria inspection to draft with its saved results', async () => {
  const id = await open(listedCar());
  await save(id, { odo, results: results() }).expect(200);
  Object.assign(h.record(id), { status: 'PENDING_APPROVAL', submittedBy: inspector.id, submittedAt: new Date() });
  await api().put(`${base}/${id}/reject`).set('Authorization', admin.auth)
    .send({ reason: 'Cần kiểm tra lại tình trạng thân vỏ' }).expect(200);
  const { body } = await get(id).expect(200);
  expect(body.data).toMatchObject({ status: 'DRAFT', templateRevision: 2 });
  expect(body.data.results).toHaveLength(groups.length);
  expect(h.records.get(id)).not.toHaveProperty('checklistSnapshot');
  await save(id, { results: [{ criterionId: 'G6_BODYWORK', outcome: 'FAIL' }] }).expect(200);
});

test('rejects the legacy quick inspection route for a car using the criteria template', async () => {
  const carId = h.createCar({ status: 'INCOMING', mileage: 50_000 });
  const response = await api().post(`${base}/cars/${carId}/inspect`).set('Authorization', inspector.auth).send({
    criteria: {
      noMajorAccident: true, noWaterDamage: true, engineGearboxIntact: true,
      verifiedOdo: true, electricalSystemPassed: true,
    },
    odo,
  }).expect(409);
  expect(response.body.code).toBe('INSPECTION_CRITERIA_REQUIRED');
  expect(h.records.size).toBe(0);
  expect(h.car(carId).status).toBe('INCOMING');
});

test('serializes result writes and submission so locked results cannot be overwritten', async () => {
  const id = await open(h.createCar({ status: 'INCOMING', mileage: 50_000 }));
  await save(id, { odo, results: results() }).expect(200);
  const [submitted, write] = await Promise.all([
    submit(id), save(id, { results: [{ criterionId: 'G6_BODYWORK', outcome: 'FAIL' }] }),
  ]);
  expect(submitted.status).toBe(200);
  expect([200, 409]).toContain(write.status);
  const { body } = await get(id).expect(200);
  expect(body.data.status).toBe('SUBMITTED');
  expect(body.data.results.find(({ criterionId }) => criterionId === 'G6_BODYWORK').outcome)
    .toBe(write.status === 200 ? 'FAIL' : 'PASS');
  await save(id, { results: results() }).expect(409);
});

test('allows a saved questionnaire draft to submit against v1 after the head switches to criteria v2', async () => {
  const carId = h.createCar({ status: 'UNDER_INSPECTION', mileage: 50_000 });
  const id = h.insertRecord({
    carId, source: 'STAFF', status: 'DRAFT', templateKey: 'GASOLINE', checklistVersion: '1',
    vehicleInfo: {
      original: { make: 'Toyota', model: 'Vios', variant: '1.5G', color: 'Trắng', year: 2020, mileage: 50_000 },
    },
  });
  h.fillDraft(id, { mileage: odo });
  const { body } = await api().post(`${base}/${id}/submit`).set('Authorization', inspector.auth)
    .send({ baseRevision: 1 }).expect(200);
  expect(h.records.get(id).checklistSnapshot).toMatchObject({ revision: 1 });
  expect(body.data.inspectionRecord).toMatchObject({ checklistVersion: '1', odo, result: 'PASSED' });
});
