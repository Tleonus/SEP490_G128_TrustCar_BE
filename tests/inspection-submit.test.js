/**
 * @file inspection-submit.test.js
 * @description Integration tests (real app, in-memory persistence) for submitting
 * a digital inspection checklist: verdict, certificate, validation, mileage,
 * locking, concurrency and rollback.
 */

import request from 'supertest';
import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';
import { getChecklist } from '../src/config/inspectionChecklist.js';

const h = await setupInspectionHarness();
const api = () => request(h.app);
const BASE = '/api/v1/inspections';
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME;
const photo = (id, name) => `https://res.cloudinary.com/${CLOUD}/image/upload/v1/trustcar/inspections/${id}/${name}.jpg`;

let staff;
let carId;
let id;

/** Fills the stored draft so that it satisfies every submit rule (all items PASS). */
const fillDraft = (overrides = {}) => {
  const raw = h.record(id);
  raw.vehicleInfo.confirmed = { ...raw.vehicleInfo.original, mileage: 50000, ...overrides.vehicle };
  raw.overviewPhotos = { FRONT: photo(id, 'f'), REAR: photo(id, 'r'), LEFT: photo(id, 'l'), RIGHT: photo(id, 'rt') };
  raw.groups = getChecklist().map((def) => ({
    groupKey: def.key,
    items: def.items.map((item) => ({ itemKey: item.key, result: 'PASS', note: '', photos: [] })),
    note: def.key === 'G1_BODY_FRAME' ? 'Thân vỏ tốt' : '',
    photos: [photo(id, def.key)],
    odometerPhoto: def.requiresOdometerPhoto ? photo(id, 'odo') : null,
    minorDefects: [],
    passed: null,
  }));
  return raw;
};

const submit = (who = staff) => api().post(`${BASE}/${id}/submit`).set('Authorization', who.auth);

beforeEach(async () => {
  h.reset();
  staff = await h.loginAs('INSPECTOR');
  carId = h.createCar({ status: 'INCOMING', mileage: 48000 });
  id = (await api().post(`${BASE}/cars/${carId}/draft`).set('Authorization', staff.auth)).body.data._id;
  h.activity.length = 0;
});

describe('POST /inspections/:id/submit — verdict', () => {
  test('all items PASS → APPROVED_CPO with a certificate on both car and record', async () => {
    fillDraft();

    const res = await submit();

    expect(res.status).toBe(200);
    const { car, inspectionRecord: record } = res.body.data;
    expect(car.status).toBe('APPROVED_CPO');
    expect(record.cpoCertificateId).toMatch(/^CPO-\d{8}-[0-9A-F]{4}$/);
    expect(car.cpoCertificateId).toBe(record.cpoCertificateId);
    expect(record).toMatchObject({ status: 'SUBMITTED', result: 'PASSED', odo: 50000, source: 'STAFF' });
    expect(Object.values(record.criteria).every((v) => v === true)).toBe(true);
    expect(record.groups.every((g) => g.passed === true)).toBe(true);
    expect(record.notes).toContain('Thân vỏ tốt');
    expect(record.evidenceImages).toHaveLength(4 + 5 + 1);
    expect(String(record.submittedBy)).toBe(staff.id);
    expect(h.car(carId).mileage).toBe(50000);
    expect(h.activity.map((a) => a.eventType)).toEqual(['INSPECTION_SUBMITTED', 'CAR_STATUS_CHANGED']);
  });

  test('a NOT_CHECKABLE item with a reason can be submitted → REJECTED without certificate', async () => {
    const raw = fillDraft();
    raw.groups[2].items[0] = { itemKey: 'ENGINE_START_NOISE', result: 'NOT_CHECKABLE', note: 'Hết ắc quy', photos: [] };

    const res = await submit();

    expect(res.status).toBe(200);
    expect(res.body.data.car).toMatchObject({ status: 'REJECTED', cpoCertificateId: null });
    expect(res.body.data.inspectionRecord).toMatchObject({ result: 'FAILED', cpoCertificateId: null });
    expect(res.body.data.inspectionRecord.criteria.engineGearboxIntact).toBe(false);
  });
});

describe('POST /inspections/:id/submit — validation', () => {
  test('lists every violation at once and changes nothing', async () => {
    const raw = fillDraft();
    raw.overviewPhotos.REAR = null;
    raw.groups[3].odometerPhoto = null;
    raw.groups[0].items[0] = { itemKey: 'CHASSIS_RAILS', result: 'FAIL', note: 'Cong', photos: [] };
    const before = JSON.stringify(h.record(id));

    const res = await submit();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSPECTION_INCOMPLETE');
    expect(res.body.errors.map((e) => e.field)).toEqual(expect.arrayContaining([
      'overviewPhotos.REAR', 'groups.3.odometerPhoto', 'groups.0.items.0.photos',
    ]));
    expect(JSON.stringify(h.record(id))).toBe(before);
    expect(h.car(carId).status).toBe('UNDER_INSPECTION');
  });

  test('actual mileage below the stored mileage → 400 with MILEAGE_DECREASE', async () => {
    fillDraft({ vehicle: { mileage: 47000 } });

    const res = await submit();

    expect(res.status).toBe(400);
    expect(res.body.errors.map((e) => e.code)).toContain('MILEAGE_DECREASE');
  });

  test('equal mileage keeps the stored mileage', async () => {
    fillDraft({ vehicle: { mileage: 48000 } });

    expect((await submit()).status).toBe(200);
    expect(h.car(carId).mileage).toBe(48000);
  });
});

describe('POST /inspections/:id/submit — locking, concurrency and rollback', () => {
  test('after submit: PATCH, submit and upload-signature → 409 INSPECTION_LOCKED', async () => {
    fillDraft();
    await submit();

    expect((await submit()).body.code).toBe('INSPECTION_LOCKED');
    expect((await api().patch(`${BASE}/${id}`).set('Authorization', staff.auth)
      .send({ vehicleInfo: { confirmed: { make: 'X' } } })).status).toBe(409);
    expect((await api().post(`${BASE}/${id}/upload-signature`).set('Authorization', staff.auth)).status).toBe(409);
  });

  test('two concurrent submits → exactly one succeeds and one certificate is issued', async () => {
    fillDraft();

    const results = await Promise.all([submit(), submit()]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const codes = [...h.cars.values()].map((c) => c.cpoCertificateId).filter(Boolean);
    expect(codes).toHaveLength(1);
    expect(h.activity.filter((a) => a.eventType === 'INSPECTION_SUBMITTED')).toHaveLength(1);
  });

  test('a failure while saving the car rolls everything back', async () => {
    fillDraft();
    h.failNextCarSaves(1);

    const res = await submit();

    expect(res.status).toBe(500);
    expect(h.record(id).status).toBe('DRAFT');
    expect(h.car(carId)).toMatchObject({ status: 'UNDER_INSPECTION', cpoCertificateId: null, mileage: 48000 });
    expect(h.activity).toHaveLength(0);
  });

  test('certificate code clashes are retried; after 3 clashes → 500 and nothing changes', async () => {
    fillDraft();
    h.forceCpoCollisions(2);
    expect((await submit()).status).toBe(200);

    h.reset();
    staff = await h.loginAs('INSPECTOR');
    carId = h.createCar({ status: 'INCOMING', mileage: 48000 });
    id = (await api().post(`${BASE}/cars/${carId}/draft`).set('Authorization', staff.auth)).body.data._id;
    fillDraft();
    h.forceCpoCollisions(3);

    const res = await submit();

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('CPO_CODE_GENERATION_FAILED');
    expect(h.record(id).status).toBe('DRAFT');
  });

  test('the car left UNDER_INSPECTION meanwhile → 409 INVALID_CAR_STATUS', async () => {
    fillDraft();
    h.car(carId).status = 'DELISTED';

    const res = await submit();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_CAR_STATUS');
  });

  test('CUSTOMER cannot submit; unknown id → 404', async () => {
    fillDraft();
    expect((await submit(await h.loginAs('CUSTOMER'))).status).toBe(403);
    expect((await api().post(`${BASE}/65f000000000000000000099/submit`).set('Authorization', staff.auth)).status).toBe(404);
  });
});
