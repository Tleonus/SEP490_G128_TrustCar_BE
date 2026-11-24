import request from 'supertest';
import { Permissions, ROLE_PERMISSIONS, Roles } from '../src/constants/appConstants.js';
import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';

const h = await setupInspectionHarness();
const api = () => request(h.app);
const BASE = '/api/v1/inspections';
const { INSPECTION_READ: read, INSPECTION_SUBMIT: submit, INSPECTION_ADMIN: manage } = Permissions;
const create = (carId, actor) => api().post(`${BASE}/cars/${carId}/draft`).set('Authorization', actor.auth);
const view = (id, actor) => api().get(`${BASE}/${id}`).set('Authorization', actor.auth);
const sendForApproval = (id, actor) => api().post(`${BASE}/${id}/submit`).set('Authorization', actor.auth).send({ baseRevision: 1 });
const reject = (id, actor) => api().put(`${BASE}/${id}/reject`).set('Authorization', actor.auth)
  .send({ reason: 'Cần bổ sung ảnh kiểm định.' });

beforeEach(() => h.reset());

test('INSPECTOR can create, read and submit, and receives 403 on admin routes', async () => {
  const inspector = await h.loginAs('INSPECTOR');
  const carId = h.createCar({ fuelType: 'ELECTRIC' });
  const { body } = await create(carId, inspector).expect(201);
  const id = body.data._id;
  expect(body.data).toMatchObject({ status: 'DRAFT', templateKey: 'ELECTRIC' });
  await view(id, inspector).expect(200);
  h.fillDraft(id);
  await sendForApproval(id, inspector).expect(200);
  await reject(id, inspector).expect(403);
  await api().post(`${BASE}/${id}/approve`).set('Authorization', inspector.auth).expect(403);
  await api().put(`${BASE}/cars/${carId}/approve-sale`).set('Authorization', inspector.auth).expect(403);
});

test.each(['fallback', 'populated'])('SALES_STAFF plus INSPECTOR inherits write via %s roles', async (source) => {
  const actor = await h.loginAs('SALES_STAFF', ['SALES_STAFF', 'INSPECTOR']);
  if (source === 'populated') {
    h.setPopulatedRoles(actor.id, {
      SALES_STAFF: ROLE_PERMISSIONS[Roles.SALES_STAFF],
      INSPECTOR: ROLE_PERMISSIONS[Roles.INSPECTOR],
    });
  }
  const { body } = await create(h.createCar(), actor).expect(201);
  const id = body.data._id;
  await api().patch(`${BASE}/${id}`).set('Authorization', actor.auth).send({
    baseRevision: 1, answers: [{ questionId: 'GASOLINE-G1_BODY_FRAME', value: 'pass' }],
  }).expect(200);
  h.fillDraft(id);
  await sendForApproval(id, actor).expect(200);
});

test('populated permissions govern Sales Staff and do not fall back to the default matrix', async () => {
  const sales = await h.loginAs('SALES_STAFF');
  const inspector = await h.loginAs('INSPECTOR');
  const { body } = await create(h.createCar(), inspector).expect(201);
  const id = body.data._id;
  h.fillDraft(id);

  h.setPopulatedRoles(sales.id, { SALES_STAFF: [read] });
  await view(id, sales).expect(200);
  await sendForApproval(id, sales).expect(403);

  h.setPopulatedRoles(sales.id, { SALES_STAFF: [read, submit] });
  await create(h.createCar(), sales).expect(403);
  await api().patch(`${BASE}/${id}`).set('Authorization', sales.auth).send({ baseRevision: 1 }).expect(403);
  await sendForApproval(id, sales).expect(200);
  await reject(id, sales).expect(403);
  expect(h.record(id).status).toBe('PENDING_APPROVAL');
});

test('requires both the ADMIN role and inspection administration permission', async () => {
  const inspector = await h.loginAs('INSPECTOR');
  const admin = await h.loginAs('SALES_STAFF', ['SALES_STAFF', 'ADMIN']);
  const { body } = await create(h.createCar(), inspector).expect(201);
  const id = body.data._id;
  h.fillDraft(id);
  await sendForApproval(id, inspector).expect(200);
  h.setPopulatedRoles(inspector.id, { INSPECTOR: [read, manage] });
  await reject(id, inspector).expect(403);
  h.setPopulatedRoles(admin.id, { SALES_STAFF: [read], ADMIN: [] });
  await reject(id, admin).expect(403);
  h.setPopulatedRoles(admin.id, { SALES_STAFF: [read], ADMIN: [manage] });
  await reject(id, admin).expect(200);
  expect(h.record(id).status).toBe('DRAFT');
});

test('ADMIN publishes a form revision through the mounted router', async () => {
  const admin = await h.loginAs('ADMIN');
  const sales = await h.loginAs('SALES_STAFF');
  const url = `${BASE}/form-templates/ELECTRIC`;
  const { body } = await api().get(url).set('Authorization', sales.auth).expect(200);
  const groups = body.data.groups;
  groups[0].questions.push({ id: 'new-note', label: 'Ghi chú', required: false, type: 'TEXT', config: { maxLength: 60 } });
  const put = (actor) => api().put(url).set('Authorization', actor.auth).send({ baseRevision: 1, groups });
  await put(sales).expect(403);
  const published = await put(admin).expect(200);
  expect(published.body.data).toMatchObject({ templateKey: 'ELECTRIC', revision: 2 });
  expect(h.formAudit).toMatchObject([{ eventType: 'INSPECTION_TEMPLATE_PUBLISHED', revision: 2 }]);
  const gas = await api().get(`${BASE}/form-templates/GASOLINE`).set('Authorization', sales.auth).expect(200);
  expect(gas.body.data.revision).toBe(1);
  expect((await put(admin).expect(409)).body.code).toBe('FORM_REVISION_CONFLICT');
});

test('CUSTOMER cannot read or create inspection records', async () => {
  const customer = await h.loginAs('CUSTOMER');
  await create(h.createCar(), customer).expect(403);
  await view('507f1f77bcf86cd799439011', customer).expect(403);
});
