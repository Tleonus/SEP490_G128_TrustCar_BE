import { expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { CarStatus, FuelType, InspectionStatus, Permissions, Roles } from '../src/constants/appConstants.js';
import { CPO_CRITERIA, InspectionResult } from '../src/domain/inspection/criteria.js';
import { createInspectionRouter } from '../src/interface/inspection/inspectionRouter.js';
import { wireInspection } from '../src/infra/inspection/wireInspection.js';
import { AppError } from '../src/utils/apiResponse.js';

const base = '/api/v1/inspections';
const id = '000000000000000000000001';
const carId = '000000000000000000000002';
const sales = '000000000000000000000003';
const inspector = '000000000000000000000004';
const admin = '000000000000000000000005';
const submit = 'inspection:submit';
const { INSPECTION_READ: read, INSPECTION_WRITE: write, INSPECTION_ADMIN: manage } = Permissions;
const actors = new Map([
  ['sales', { id: sales, roles: [Roles.SALES_STAFF], permissions: [read, submit] }],
  ['inspector', { id: inspector, roles: [Roles.SALES_STAFF, Roles.INSPECTOR], permissions: [read, write, submit] }],
  ['admin', { id: admin, roles: [Roles.SALES_STAFF, Roles.ADMIN], permissions: [read, write, submit, manage] }],
  ['non-admin', { id: inspector, roles: [Roles.INSPECTOR], permissions: [read, write, manage] }],
]);

function appFor(useCases) {
  const app = express();
  app.use(express.json());
  app.use(base, createInspectionRouter({
    useCases,
    authenticate(req, _res, next) {
      const identity = actors.get(req.get('Authorization'));
      if (!identity) return next(new AppError('Token is invalid', 401, 'TOKEN_INVALID'));
      req.user = { roleName: identity.roles[0] };
      req.userId = identity.id;
      req.userRoleNames = identity.roles;
      req.userPermissions = identity.permissions;
      return next();
    },
  }));
  return request(app);
}

const template = {
  templateKey: FuelType.ELECTRIC, revision: 1,
  groups: CPO_CRITERIA.map(({ key, ...criterion }) => ({
    key, ...criterion,
    questions: [{
      id: key, label: 'Kết quả', required: true, type: 'SINGLE_CHOICE',
      config: { options: [{ id: 'pass', label: 'Đạt', result: InspectionResult.PASS }] },
    }],
  })),
  retiredIds: { questions: [], options: [] },
};

test.each([
  { answers: [{ questionId: 'q', value: 'updated' }] },
  { overviewPhotos: { FRONT: 'https://example.test/image.jpg' } },
  { vehicleInfo: { confirmed: { mileage: 999 } }, status: 'SUBMITTED' },
  { templateRevision: 2 }, { extra: true },
])('rejects every extra submit field before calling the use case', async (extra) => {
  const submitInspection = jest.fn();
  const res = await appFor({ submitInspection }).post(`${base}/${id}/submit`)
    .set('Authorization', 'sales').send({ baseRevision: 1, ...extra }).expect(422);
  expect(res.body).toMatchObject({
    success: false, code: 'VALIDATION_ERROR', error_code: 'VALIDATION_ERROR',
    request_id: expect.any(String), timestamp: expect.any(String),
  });
  expect(submitInspection).not.toHaveBeenCalled();
});

test.each([{}, { baseRevision: '1' }, { baseRevision: 0 }, { baseRevision: 1.1 }, [{ baseRevision: 1 }]]
  .map((input) => ({ input })))(
  'rejects a missing or invalid baseRevision', async ({ input }) => {
    const submitInspection = jest.fn();
    await appFor({ submitInspection }).post(`${base}/${id}/submit`)
      .set('Authorization', 'sales').send(input).expect(422);
    expect(submitInspection).not.toHaveBeenCalled();
  },
);

test('gives Sales Staff read/submit and checks write separately for draft, signatures and quick inspection', async () => {
  const submitInspection = jest.fn(async () => ({ id, status: 'PENDING_APPROVAL' }));
  const getInspection = jest.fn(async () => ({ id, source: 'STAFF', status: 'DRAFT' }));
  const api = appFor({ submitInspection, getInspection });
  await api.get(`${base}/${id}`).set('Authorization', 'sales').expect(200);
  await api.post(`${base}/${id}/submit`).set('Authorization', 'sales').send({ baseRevision: 1 }).expect(200);
  expect(submitInspection).toHaveBeenCalledWith(id, sales, 1);
  for (const [method, path] of [
    ['post', `/cars/${carId}/draft`], ['patch', `/${id}`], ['post', `/${id}/upload-signature`],
    ['post', `/cars/${carId}/upload-signature`], ['post', `/cars/${carId}/inspect`],
  ]) {
    await api[method](base + path).set('Authorization', 'sales').expect(403);
  }
});

test('authorizes form writes by full role set and validates configuration shape', async () => {
  const getTemplate = jest.fn(() => template);
  const updateTemplate = jest.fn(() => ({ ...template, revision: 2 }));
  const api = appFor({ getTemplate, updateTemplate });
  await api.get(`${base}/form-templates/ELECTRIC`).set('Authorization', 'sales').expect(200);
  const payload = { baseRevision: 1, groups: template.groups };
  await api.put(`${base}/form-templates/ELECTRIC`).set('Authorization', 'non-admin').send(payload).expect(403);
  const malformed = structuredClone(payload);
  malformed.groups[0].questions[0].config = { maxLength: 5 };
  await api.put(`${base}/form-templates/ELECTRIC`).set('Authorization', 'admin').send(malformed).expect(422);
  expect(updateTemplate).not.toHaveBeenCalled();
  await api.put(`${base}/form-templates/ELECTRIC`).set('Authorization', 'admin').send(payload).expect(200);
  expect(updateTemplate).toHaveBeenCalledWith('ELECTRIC', admin, payload);
});

test('strips server-owned draft fields and routes only authenticated actor data', async () => {
  const updateDraft = jest.fn(() => ({ id, status: 'DRAFT' }));
  const api = appFor({ updateDraft });
  await api.patch(`${base}/${id}`).set('Authorization', 'inspector').send({
    baseRevision: 1, status: 'SUBMITTED', approvedBy: admin,
    vehicleInfo: { original: { mileage: 99 }, confirmed: { mileage: 500 } },
    answers: [{ questionId: 'q', value: null }], groups: [{ groupKey: CPO_CRITERIA[0].key, note: '  Note  ' }],
  }).expect(200);
  expect(updateDraft).toHaveBeenCalledWith(id, inspector, {
    baseRevision: 1, vehicleInfo: { confirmed: { mileage: 500 } },
    answers: [{ questionId: 'q', value: null }], groups: [{ groupKey: CPO_CRITERIA[0].key, note: 'Note' }],
  });
});

test('routes admin reject, quick inspection and both signatures with verified request data', async () => {
  const car = { id: carId, status: CarStatus.APPROVED_CPO };
  const inspectionRecord = { id, status: InspectionStatus.SUBMITTED, source: 'ADMIN_QUICK' };
  const inspectCar = jest.fn(() => ({ car, inspectionRecord }));
  const rejectInspection = jest.fn(() => ({ id, status: InspectionStatus.DRAFT }));
  const signInspectionUpload = jest.fn(() => ({ signature: 'fixture' }));
  const signQuickInspectionUpload = jest.fn(() => ({ signature: 'fixture' }));
  const api = appFor({ inspectCar, rejectInspection, signInspectionUpload, signQuickInspectionUpload });
  const reason = 'Inspection evidence is missing.';
  await api.put(`${base}/${id}/reject`).set('Authorization', 'admin').send({ reason }).expect(200);
  expect(rejectInspection).toHaveBeenCalledWith(id, admin, reason);
  const criteria = Object.fromEntries(CPO_CRITERIA.map(({ criteriaKey }) => [criteriaKey, true]));
  await api.post(`${base}/cars/${carId}/inspect`).set('Authorization', 'inspector').send({ criteria, odo: 200 }).expect(200);
  const identity = { id: inspector, roleNames: actors.get('inspector').roles, permissions: [read, write, submit] };
  expect(inspectCar).toHaveBeenCalledWith(carId, identity, { criteria, odo: 200, notes: '', evidenceImages: [] });
  await api.post(`${base}/${id}/upload-signature`).set('Authorization', 'inspector').expect(200);
  await api.post(`${base}/cars/${carId}/upload-signature`).set('Authorization', 'inspector').expect(200);
  expect(signInspectionUpload).toHaveBeenCalledWith(id, identity);
  expect(signQuickInspectionUpload).toHaveBeenCalledWith(carId, identity);
});

test('maps error status by operation and hides unexpected driver information', async () => {
  const badStatus = () => { throw Object.assign(new Error('vehicle state'), { code: 'INVALID_CAR_STATUS' }); };
  const api = appFor({
    submitInspection: badStatus, approveInspection: badStatus, signQuickInspectionUpload: badStatus,
    getInspection: () => { throw Object.assign(new Error('private driver detail'), { code: 11000 }); },
  });
  await api.post(`${base}/${id}/submit`).set('Authorization', 'sales').send({ baseRevision: 1 }).expect(409);
  await api.post(`${base}/${id}/approve`).set('Authorization', 'admin').expect(409);
  await api.post(`${base}/cars/${carId}/upload-signature`).set('Authorization', 'admin').expect(400);
  const failure = await api.get(`${base}/${id}`).set('Authorization', 'admin').expect(500);
  expect(failure.body.code).toBe('INTERNAL_ERROR');
  expect(failure.text).not.toContain('private driver detail');
  await api.get(`${base}/${id}`).expect(401);
  const malformedId = await api.get(`${base}/not-an-id`).set('Authorization', 'sales').expect(422);
  expect(malformedId.body.code).toBe('VALIDATION_ERROR');
});

test('preserves the open inspection ID and legacy read fields', async () => {
  const api = appFor({
    getInspection: () => ({ id, criteria: { verifiedOdo: true }, privateField: 'hidden' }),
    createDraft: () => { throw Object.assign(new Error('open'), {
      code: 'INSPECTION_PENDING_APPROVAL', errors: [{ field: 'inspectionId', message: id }],
    }); },
  });
  const legacy = await api.get(`${base}/${id}`).set('Authorization', 'sales').expect(200);
  expect(legacy.body.data).toEqual({ _id: id, criteria: { verifiedOdo: true }, status: 'SUBMITTED', source: 'LEGACY' });
  const open = await api.post(`${base}/cars/${carId}/draft`).set('Authorization', 'inspector').expect(409);
  expect(open.body).toMatchObject({ code: 'INSPECTION_PENDING_APPROVAL', errors: [{ field: 'inspectionId', message: id }] });
});

function composedUseCases() {
  const state = {
    car: {
      id: carId, status: CarStatus.INCOMING, mileage: 1000, fuelType: FuelType.ELECTRIC,
      make: 'VinFast', model: 'VF 8', variant: 'Eco', color: 'Blue', year: 2025,
    },
    record: null, events: [],
  };
  const selected = ({ session } = {}) => session ?? state;
  const useCases = wireInspection({
    runTransaction: async (run) => {
      const working = structuredClone(state);
      const output = await run(working);
      Object.assign(state, working);
      return output;
    },
    makeTemplates: () => ({ findCurrent: async () => template }),
    makeCars: (options) => {
      const store = selected(options);
      return {
        findById: async () => ({ ...store.car }),
        claimForInspection: async () => ({ ...store.car }),
        updateIfCurrent: async (_id, expected, fields) => store.car.status === expected.status
          ? Object.assign(store.car, fields) : null,
      };
    },
    makeRecords: (options) => {
      const store = selected(options);
      return {
        findById: async () => store.record,
        findOpenByCarId: async () => store.record,
        insert: async (fields) => (store.record = { ...fields, id, checklistVersion: '1' }),
        updateIfCurrent: async (_id, expected, fields) => store.record?.status === expected.status
          ? Object.assign(store.record, fields) : null,
      };
    },
    bindAudit: (session) => ({ append: async (entry) => session.events.push(entry) }),
    media: { isInspectionImageUrl: (url) => url === 'https://example.test/car.jpg' },
  });
  const submitInspection = jest.fn(useCases.submitInspection);
  return { state, api: appFor({ ...useCases, submitInspection }), submitInspection };
}

test('composed router preserves the saved draft on invalid submit and completes submit then approval', async () => {
  const { state, api, submitInspection } = composedUseCases();
  const photo = 'https://example.test/car.jpg';
  await api.post(`${base}/cars/${carId}/draft`).set('Authorization', 'inspector').expect(201);
  await api.patch(`${base}/${id}`).set('Authorization', 'inspector').send({
    baseRevision: 1,
    answers: CPO_CRITERIA.map(({ key }) => ({ questionId: key, value: 'pass' })),
    overviewPhotos: { FRONT: photo, REAR: photo, LEFT: photo, RIGHT: photo },
    groups: CPO_CRITERIA.map(({ key }) => ({
      groupKey: key, photos: [photo], ...(key === 'G4_ODOMETER' ? { odometerPhoto: photo } : {}),
    })),
  }).expect(200);
  const before = structuredClone(state);
  await api.post(`${base}/${id}/submit`).set('Authorization', 'sales').send({
    baseRevision: 1, answers: [{ questionId: CPO_CRITERIA[0].key, value: null }],
  }).expect(422);
  expect(submitInspection).not.toHaveBeenCalled();
  expect(state).toEqual(before);
  const pending = await api.post(`${base}/${id}/submit`).set('Authorization', 'sales').send({ baseRevision: 1 }).expect(200);
  expect(pending.body.data).toMatchObject({
    _id: id, status: 'PENDING_APPROVAL', submittedBy: sales, checklistSnapshot: { revision: 1 },
  });
  expect(state.car.status).toBe(CarStatus.UNDER_INSPECTION);
  const approved = await api.post(`${base}/${id}/approve`).set('Authorization', 'admin').expect(200);
  expect(approved.body.data).toMatchObject({
    car: { _id: carId, status: CarStatus.APPROVED_CPO },
    inspectionRecord: { _id: id, status: InspectionStatus.SUBMITTED, result: 'PASSED', approvedBy: admin },
  });
  expect(approved.body.data.car.cpoCertificateId).toBe(approved.body.data.inspectionRecord.cpoCertificateId);
});
