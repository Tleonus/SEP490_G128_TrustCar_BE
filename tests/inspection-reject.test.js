import mongoose from 'mongoose';
import request from 'supertest';
import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';

const h = await setupInspectionHarness();
const api = () => request(h.app);
const BASE = '/api/v1/inspections';
const REASON = 'Thiếu ảnh odo, cần bổ sung trước khi duyệt';

function seedPending(status = 'PENDING_APPROVAL') {
  const carId = h.createCar({ status: 'UNDER_INSPECTION', mileage: 50000 });
  const inspectorId = new mongoose.Types.ObjectId();
  const recordId = h.insertRecord({
    carId, inspectorId, status, source: 'STAFF', submittedBy: inspectorId, submittedAt: new Date(),
    templateKey: 'GASOLINE', checklistVersion: '1',
    checklistSnapshot: { templateKey: 'GASOLINE', revision: 1, groups: [] },
    answers: [{ questionId: 'GASOLINE-G1_BODY_FRAME', value: 'pass' }],
  });
  return { carId, recordId };
}

const reject = (recordId, body, who = admin) =>
  api().put(`${BASE}/${recordId}/reject`).set('Authorization', who.auth).send(body);

let admin;
let sale;
beforeEach(async () => {
  h.reset();
  admin = await h.loginAs('ADMIN');
  sale = await h.loginAs('SALES_STAFF');
});

test('admin returns a pending record to DRAFT, keeping answers and audit while leaving the car unchanged', async () => {
  const { carId, recordId } = seedPending();
  const beforeCar = JSON.stringify(h.car(carId));
  const answers = h.record(recordId).answers;
  await reject(recordId, { reason: `  ${REASON}  ` }).expect(200);
  const record = h.record(recordId);
  expect(record).toMatchObject({ status: 'DRAFT', rejectedReason: REASON, checklistSnapshot: null, answers });
  expect(String(record.rejectedByUserId)).toBe(admin.id);
  expect(record.rejectedAt).toBeInstanceOf(Date);
  expect(JSON.stringify(h.car(carId))).toBe(beforeCar);
  expect(h.activity).toMatchObject([
    { eventType: 'INSPECTION_REJECTED', metadata: { carId, reason: REASON } },
  ]);
});

test('sales staff cannot reject a pending record', async () => {
  const { recordId } = seedPending();
  const before = JSON.stringify(h.record(recordId));
  await reject(recordId, { reason: REASON }, sale).expect(403);
  expect(JSON.stringify(h.record(recordId))).toBe(before);
  expect(h.activity).toHaveLength(0);
});

test.each([{ reason: 'ngắn' }, {}, { reason: 'x'.repeat(1001) }])('validates rejection reason', async (payload) => {
  const { recordId } = seedPending();
  const res = await reject(recordId, payload).expect(422);
  expect(res.body.code).toBe('VALIDATION_ERROR');
  expect(res.body.errors.map(({ field }) => field)).toContain('reason');
  expect(h.record(recordId).status).toBe('PENDING_APPROVAL');
});

test.each(['DRAFT', 'SUBMITTED'])('reject returns 409 for %s', async (status) => {
  const { carId, recordId } = seedPending(status);
  const res = await reject(recordId, { reason: REASON }).expect(409);
  expect(res.body.code).toBe('INSPECTION_NOT_PENDING_APPROVAL');
  expect(h.record(recordId).status).toBe(status);
  expect(h.record(recordId).rejectedReason).toBeUndefined();
  expect(h.car(carId).status).toBe('UNDER_INSPECTION');
  expect(h.activity).toHaveLength(0);
});

test('returns 404 for an unknown record and 422 for an invalid ID', async () => {
  const res = await reject('65f000000000000000000099', { reason: REASON }).expect(404);
  expect(res.body.code).toBe('INSPECTION_NOT_FOUND');
  await reject('not-an-id', { reason: REASON }).expect(422);
});

test('sales staff can read the rejected draft and its reason', async () => {
  const { recordId } = seedPending();
  await reject(recordId, { reason: REASON }).expect(200);
  const read = await api().get(`${BASE}/${recordId}`).set('Authorization', sale.auth).expect(200);
  expect(read.body.data).toMatchObject({ status: 'DRAFT', rejectedReason: REASON });
});
