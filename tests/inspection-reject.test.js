/**
 * @file inspection-reject.test.js
 * @description Integration tests (real app, in-memory persistence) for KAN-53:
 * admin rejects a submitted biên bản and returns it to the sale staff for
 * revision. The record flips back to DRAFT with rejection trace fields; the
 * car status is intentionally left untouched.
 */

import mongoose from 'mongoose';
import request from 'supertest';
import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';

const h = await setupInspectionHarness();
const api = () => request(h.app);
const BASE = '/api/v1/inspections';

const REASON = 'Thiếu ảnh odo nhóm G3, cần chụp lại trước khi duyệt';

/** Seeds a SUBMITTED inspection for a car that stayed UNDER_INSPECTION. */
const seedSubmitted = (overrides = {}) => {
  const carId = h.createCar({ status: 'UNDER_INSPECTION', mileage: 50000, ...overrides.car });
  const inspectorId = new mongoose.Types.ObjectId();
  const recordId = h.insertRecord({
    carId,
    inspectorId,
    status: 'SUBMITTED',
    source: 'STAFF',
    criteria: {
      noMajorAccident: true,
      noWaterDamage: true,
      engineGearboxIntact: true,
      verifiedOdo: true,
      electricalSystemPassed: true,
    },
    odo: 50000,
    notes: 'OK',
    evidenceImages: [],
    result: 'PASSED',
    cpoCertificateId: null,
    submittedBy: inspectorId,
    submittedAt: new Date(),
    createdBy: inspectorId,
    updatedBy: inspectorId,
    ...overrides.record,
  });
  return { carId, recordId };
};

const reject = (recordId, body, who) =>
  api().put(`${BASE}/${recordId}/reject`).set('Authorization', who.auth).send(body);

let admin;
let sale;
beforeEach(async () => {
  h.reset();
  admin = await h.loginAs('ADMIN');
  sale = await h.loginAs('SALES_STAFF');
});

describe('PUT /inspections/:id/reject (KAN-53)', () => {
  test('admin with a valid reason → 200, record DRAFT with trace, car still UNDER_INSPECTION', async () => {
    const { carId, recordId } = seedSubmitted();

    const res = await reject(recordId, { reason: REASON }, admin);

    expect(res.status).toBe(200);
    const stored = h.record(recordId);
    expect(stored.status).toBe('DRAFT');
    expect(stored.rejectedReason).toBe(REASON);
    expect(String(stored.rejectedByUserId)).toBe(admin.id);
    expect(stored.rejectedAt).toBeInstanceOf(Date);
    // Car MUST stay untouched — the lifecycle of the vehicle is unaffected.
    expect(h.car(carId).status).toBe('UNDER_INSPECTION');
    expect(h.activity.map((a) => a.eventType)).toEqual(['INSPECTION_REJECTED']);
    expect(h.activity[0].metadata).toMatchObject({ carId: String(carId), reason: REASON });
  });

  test('reason is trimmed before storing', async () => {
    const { recordId } = seedSubmitted();

    const res = await reject(recordId, { reason: `   ${REASON}   ` }, admin);

    expect(res.status).toBe(200);
    expect(h.record(recordId).rejectedReason).toBe(REASON);
  });

  test('sale staff → 403 FORBIDDEN, record unchanged', async () => {
    const { carId, recordId } = seedSubmitted();

    const res = await reject(recordId, { reason: REASON }, sale);

    expect(res.status).toBe(403);
    expect(h.record(recordId).status).toBe('SUBMITTED');
    expect(h.record(recordId).rejectedReason).toBeUndefined();
    expect(h.car(carId).status).toBe('UNDER_INSPECTION');
    expect(h.activity).toHaveLength(0);
  });

  test('reason shorter than 10 chars → 422 VALIDATION_ERROR, nothing changes', async () => {
    const { recordId } = seedSubmitted();

    const res = await reject(recordId, { reason: 'ngắn' }, admin);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.errors.map((e) => e.field)).toContain('reason');
    expect(h.record(recordId).status).toBe('SUBMITTED');
    expect(h.record(recordId).rejectedReason).toBeUndefined();
  });

  test('missing reason → 422 VALIDATION_ERROR', async () => {
    const { recordId } = seedSubmitted();

    const res = await reject(recordId, {}, admin);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('reason longer than 1000 chars → 422 VALIDATION_ERROR', async () => {
    const { recordId } = seedSubmitted();

    const res = await reject(recordId, { reason: 'x'.repeat(1001) }, admin);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('record is already a DRAFT → 409 INSPECTION_NOT_SUBMITTED, nothing changes', async () => {
    const { carId, recordId } = seedSubmitted({ record: { status: 'DRAFT' } });

    const res = await reject(recordId, { reason: REASON }, admin);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSPECTION_NOT_SUBMITTED');
    expect(h.record(recordId).status).toBe('DRAFT');
    expect(h.record(recordId).rejectedReason).toBeUndefined();
    expect(h.car(carId).status).toBe('UNDER_INSPECTION');
    expect(h.activity).toHaveLength(0);
  });

  test('unknown inspection id → 404', async () => {
    const res = await reject('65f000000000000000000099', { reason: REASON }, admin);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('INSPECTION_NOT_FOUND');
  });

  test('invalid ObjectId → 422 from params validator', async () => {
    const res = await reject('not-an-id', { reason: REASON }, admin);

    expect(res.status).toBe(422);
  });

  test('sale staff may reopen the rejected record as a draft (read)', async () => {
    const { recordId } = seedSubmitted();
    await reject(recordId, { reason: REASON }, admin);

    const read = await api().get(`${BASE}/${recordId}`).set('Authorization', sale.auth);

    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({
      status: 'DRAFT',
      rejectedReason: REASON,
    });
  });
});
