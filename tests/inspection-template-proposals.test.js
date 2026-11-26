import request from 'supertest';
import { CPO_CRITERIA } from '../src/domain/inspection/criteria.js';
import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';

const h = await setupInspectionHarness();
const inspections = '/api/v1/inspections';
const proposals = inspections + '/form-template-proposals';
const template = inspections + '/form-templates/GASOLINE';
const groups = CPO_CRITERIA.map(({ key, label }) => ({ key, label, required: true }));
const extended = [...groups, { key: 'G6_BRAKES', label: 'Hệ thống phanh', required: true }];
const draft = { templateKey: 'GASOLINE', baseRevision: 1, groups };
const api = () => request(h.app);
let inspector;
let admin;

beforeEach(async () => {
  h.reset();
  inspector = await h.loginAs('INSPECTOR');
  admin = await h.loginAs('ADMIN');
});

async function create(body = draft, author = inspector) {
  const response = await api().post(proposals).set('Authorization', author.auth).send(body).expect(201);
  return response.body.data._id;
}

const act = (id, action, user) => api().post(`${proposals}/${id}/${action}`).set('Authorization', user.auth);
const list = (user) => api().get(proposals).set('Authorization', user.auth);
const detail = (id, user) => api().get(`${proposals}/${id}`).set('Authorization', user.auth);
const edit = (id, user) => api().put(`${proposals}/${id}`).set('Authorization', user.auth);
const current = () => api().get(template).set('Authorization', inspector.auth);
const publishedEvents = () => h.activity.filter(({ eventType }) => eventType === 'INSPECTION_TEMPLATE_PUBLISHED');

test('a returned proposal can be revised and published; a certified car moves to v2 only after passing reinspection', async () => {
  const carId = h.createCar({ status: 'AVAILABLE', cpoCertificateId: 'CPO-V1', historyVerifyHash: 'previous' });
  const oldRecord = h.insertRecord({ carId, result: 'PASSED', status: 'SUBMITTED', cpoCertificateId: 'CPO-V1',
    checklistVersion: '1', templateKey: 'GASOLINE', inspectorId: inspector.id });
  const id = await create();
  await act(id, 'submit', inspector).expect(200);
  const reason = 'Bổ sung tiêu chí kiểm tra phanh';
  const returned = await act(id, 'return', admin).send({ reason }).expect(200);
  expect(returned.body.data).toMatchObject({ status: 'DRAFT', reviewNote: reason, reviewedBy: admin.id });
  await edit(id, inspector).send({ baseRevision: 1, groups: extended }).expect(200);
  await act(id, 'submit', inspector).expect(200);
  expect((await current().expect(200)).body.data.revision).toBe(1);
  const revision = (await act(id, 'approve', admin).expect(200)).body.data;
  expect(revision).toMatchObject({ revision: 2, format: 'CRITERIA', groups: extended });
  expect((await current().expect(200)).body.data).toEqual(revision);
  expect((await act(id, 'approve', admin).expect(200)).body.data).toEqual(revision);
  expect(publishedEvents()).toHaveLength(1);
  expect((await detail(id, inspector).expect(200)).body.data).toMatchObject({ status: 'APPROVED',
    publishedRevisionId: String(publishedEvents()[0].targetId), reviewedBy: admin.id });
  expect(h.car(carId).cpoCertificateId).toBe('CPO-V1');
  const certificate = () => api().get(`${inspections}/cars/${carId}/current-certificate`).set('Authorization', inspector.auth);
  expect((await certificate().expect(200)).body.data).toEqual({
    inspectionId: oldRecord, templateKey: 'GASOLINE', templateRevision: 1, cpoCertificateId: 'CPO-V1',
  });
  const opened = await api().post(`${inspections}/cars/${carId}/draft`).set('Authorization', inspector.auth).expect(201);
  const record = `${inspections}/${opened.body.data._id}`;
  expect(opened.body.data).toMatchObject({ checklistVersion: '2' });
  const patch = (answers) => api().patch(record).set('Authorization', inspector.auth)
    .send({ baseRevision: 2, odo: 51_000, results: answers.map(({ key }) => ({ criterionId: key, outcome: 'PASS' })) });
  const submit = () => api().post(record + '/submit').set('Authorization', inspector.auth).send({ baseRevision: 2 });
  await patch(groups).expect(200);
  await submit().expect(400);
  await patch([extended.at(-1)]).expect(200);
  await submit().expect(200);
  expect(h.car(carId).cpoCertificateId).toBe('CPO-V1');
  expect((await certificate().expect(200)).body.data.templateRevision).toBe(1);
  await api().post(record + '/approve').set('Authorization', admin.auth).expect(200);
  expect(h.car(carId).cpoCertificateId).not.toBe('CPO-V1');
  expect(h.car(carId).status).toBe('AVAILABLE');
  expect((await certificate().expect(200)).body.data).toMatchObject({
    inspectionId: opened.body.data._id, templateRevision: 2, cpoCertificateId: h.car(carId).cpoCertificateId,
  });
  expect(h.record(oldRecord)).toMatchObject({ checklistVersion: '1', cpoCertificateId: 'CPO-V1' });
});

test('certificate reads require read access and report only a known version of the matching finalized record', async () => {
  const carId = h.createCar({ status: 'AVAILABLE', cpoCertificateId: 'CPO-LEGACY' });
  const url = `${inspections}/cars/${carId}/current-certificate`;
  const sales = await h.loginAs('SALES_STAFF');
  const read = () => api().get(url).set('Authorization', sales.auth);
  await api().get(url).expect(401);
  const customer = await h.loginAs('CUSTOMER');
  await api().get(url).set('Authorization', customer.auth).expect(403);
  h.insertRecord({ carId, status: 'SUBMITTED', result: 'PASSED', cpoCertificateId: 'CPO-OLDER', checklistVersion: '9' });
  expect((await read().expect(404)).body.code).toBe('CPO_CERTIFICATE_NOT_FOUND');
  const id = h.insertRecord({ carId, inspectorId: inspector.id, result: 'PASSED', cpoCertificateId: 'CPO-LEGACY' });
  const record = h.record(id);
  delete record.status;
  delete record.checklistVersion;
  expect((await read().expect(200)).body.data.templateRevision).toBeNull();
  record.checklistVersion = '1.0';
  expect((await read().expect(200)).body.data.templateRevision).toBe(1);
  record.status = 'PENDING_APPROVAL';
  await read().expect(404);
});

test('one publication wins per base revision and the losing proposal can be returned and rebased', async () => {
  const first = await create();
  const second = await create();
  await act(first, 'submit', inspector).expect(200);
  await act(second, 'submit', inspector).expect(200);
  const ids = [first, second];
  const approvals = await Promise.all(ids.map((id) => act(id, 'approve', admin)));
  expect(approvals.map(({ status }) => status).sort()).toEqual([200, 409]);
  const loserIndex = approvals.findIndex(({ status }) => status === 409);
  expect(approvals[loserIndex].body.code).toBe('FORM_REVISION_CONFLICT');
  const loser = ids[loserIndex];
  expect((await detail(loser, admin).expect(200)).body.data.status).toBe('PENDING_APPROVAL');
  expect(publishedEvents()).toHaveLength(1);
  await act(loser, 'return', admin).send({ reason: 'Cập nhật theo v2' }).expect(200);
  await edit(loser, inspector).send({ baseRevision: 2, groups: extended }).expect(200);
  await act(loser, 'submit', inspector).expect(200);
  expect((await act(loser, 'approve', admin).expect(200)).body.data.revision).toBe(3);
  expect((await act(ids[1 - loserIndex], 'approve', admin).expect(200)).body.data.revision).toBe(2);
  expect((await current().expect(200)).body.data.revision).toBe(3);
  expect(publishedEvents()).toHaveLength(2);
});

test('staff can only see and change their own drafts; review requires both role and permission', async () => {
  const other = await h.loginAs('INSPECTOR');
  const sales = await h.loginAs('SALES_STAFF');
  const id = await create();
  await api().get(proposals).expect(401);
  await list(sales).expect(403);
  await detail(id, other).expect(404);
  await detail(id, admin).expect(404);
  await edit(id, other).send({ baseRevision: 1, groups }).expect(404);
  await act(id, 'submit', other).expect(404);
  await act(id, 'submit', inspector).expect(200);
  await edit(id, inspector).send({ baseRevision: 1, groups }).expect(409);
  await act(id, 'submit', inspector).expect(409);
  expect((await list(admin).query({ status: 'PENDING_APPROVAL' }).expect(200)).body.data.items[0]._id).toBe(id);
  expect((await list(other).expect(200)).body.data.items).toEqual([]);
  h.setPopulatedRoles(other.id, { INSPECTOR: ['inspection:admin'] });
  await list(other).expect(403);
  await act(id, 'approve', other).expect(403);
  h.setPopulatedRoles(admin.id, { ADMIN: ['inspection:read'] });
  await act(id, 'return', admin).send({ reason: 'Vui lòng sửa' }).expect(403);
  await act(id, 'approve', admin).expect(403);
});

test('rejects invalid actions and paginates scoped proposal summaries', async () => {
  const other = await h.loginAs('INSPECTOR');
  const post = (body) => api().post(proposals).set('Authorization', inspector.auth).send(body);
  await post({ ...draft, groups: [groups[0], groups[0]] }).expect(422);
  await post({ ...draft, submittedBy: admin.id }).expect(422);
  await post({ ...draft, baseRevision: 9 }).expect(409);
  const first = await create();
  const last = await create();
  await create(draft, other);
  await create({ ...draft, templateKey: 'ELECTRIC' });
  const page = (await list(inspector).query({ templateKey: 'GASOLINE', limit: 1 }).expect(200)).body.data;
  expect(page.nextCursor).toBe(last);
  expect(page.items[0]).not.toHaveProperty('groups');
  const next = await list(inspector).query({ templateKey: 'GASOLINE', limit: 1, before: page.nextCursor }).expect(200);
  expect(next.body.data).toMatchObject({ items: [{ _id: first }], nextCursor: null });
  await list(inspector).query({ submittedBy: other.id }).expect(422);
  await act(first, 'submit', inspector).send({ groups: extended }).expect(422);
  await act(first, 'submit', inspector).expect(200);
  await act(first, 'approve', admin).send({ baseRevision: 2 }).expect(422);
  await act(first, 'return', admin).send({ reason: '   ' }).expect(422);
  expect((await detail(first, admin).expect(200)).body.data.status).toBe('PENDING_APPROVAL');
});
