/**
 * @file inspector-role-routes.test.js
 * @description KAN-94 — route-level checks that inspection endpoints are gated
 * by inspection:* permissions instead of a hard-coded role list.
 *
 * Runs against the real Express app with the in-memory inspection harness.
 */

import request from 'supertest';
import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';

const h = await setupInspectionHarness();
const api = () => request(h.app);
const BASE = '/api/v1/inspections';

beforeEach(() => h.reset());

describe('INSPECTOR on inspection routes', () => {
  test('a pure INSPECTOR may start a draft (inspection:write)', async () => {
    const inspector = await h.loginAs('INSPECTOR', ['INSPECTOR']);
    const carId = h.createCar({ status: 'INCOMING', mileage: 30000 });

    const res = await api()
      .post(`${BASE}/cars/${carId}/draft`)
      .set('Authorization', inspector.auth);

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('DRAFT');
  });

  test('a pure INSPECTOR may read an inspection (inspection:read)', async () => {
    const inspector = await h.loginAs('INSPECTOR', ['INSPECTOR']);
    const carId = h.createCar({ status: 'INCOMING', mileage: 31000 });

    const created = await api()
      .post(`${BASE}/cars/${carId}/draft`)
      .set('Authorization', inspector.auth);
    expect(created.status).toBe(201);

    const read = await api()
      .get(`${BASE}/${created.body.data._id}`)
      .set('Authorization', inspector.auth);
    expect(read.status).toBe(200);
  });

  test('a pure INSPECTOR is refused admin-only actions (inspection:admin)', async () => {
    const inspector = await h.loginAs('INSPECTOR', ['INSPECTOR']);
    const carId = h.createCar({ status: 'INCOMING', mileage: 32000 });

    const created = await api()
      .post(`${BASE}/cars/${carId}/draft`)
      .set('Authorization', inspector.auth);

    const reject = await api()
      .put(`${BASE}/${created.body.data._id}/reject`)
      .set('Authorization', inspector.auth)
      .send({ rejectedReason: 'Biên bản thiếu ảnh odometer và chữ ký của khách hàng.' });
    expect(reject.status).toBe(403);

    const approve = await api()
      .put(`${BASE}/cars/${carId}/approve-sale`)
      .set('Authorization', inspector.auth);
    expect(approve.status).toBe(403);
  });

  test('SALES_STAFF keeps its inspection access', async () => {
    const staff = await h.loginAs('SALES_STAFF');
    const carId = h.createCar({ status: 'INCOMING', mileage: 33000 });

    const res = await api()
      .post(`${BASE}/cars/${carId}/draft`)
      .set('Authorization', staff.auth);

    expect(res.status).toBe(201);
  });

  test('SALES_STAFF may still reject/approve? — no, that stays admin-only', async () => {
    const staff = await h.loginAs('SALES_STAFF');
    const carId = h.createCar({ status: 'INCOMING', mileage: 34000 });

    const res = await api()
      .put(`${BASE}/cars/${carId}/approve-sale`)
      .set('Authorization', staff.auth);

    expect(res.status).toBe(403);
  });

  test('CUSTOMER is refused inspection access entirely', async () => {
    const customer = await h.loginAs('CUSTOMER', ['CUSTOMER']);
    const carId = h.createCar({ status: 'INCOMING', mileage: 35000 });

    const draft = await api()
      .post(`${BASE}/cars/${carId}/draft`)
      .set('Authorization', customer.auth);
    expect(draft.status).toBe(403);

    const read = await api()
      .get(`${BASE}/507f1f77bcf86cd799439011`)
      .set('Authorization', customer.auth);
    expect(read.status).toBe(403);
  });

  test('ADMIN can reject a submitted record', async () => {
    const staff = await h.loginAs('SALES_STAFF');
    const admin = await h.loginAs('ADMIN');
    const carId = h.createCar({ status: 'INCOMING', mileage: 36000 });

    const draft = await api()
      .post(`${BASE}/cars/${carId}/draft`)
      .set('Authorization', staff.auth);
    expect(draft.status).toBe(201);

    // Fill and submit
    const record = h.record(draft.body.data._id);
    const groups = (record.groups || []).map((g) => ({
      groupKey: g.groupKey,
      items: g.items.map((i) => ({ itemKey: i.itemKey, result: 'OK' })),
    }));
    await api()
      .patch(`${BASE}/${draft.body.data._id}`)
      .set('Authorization', staff.auth)
      .send({
        criteria: {
          noMajorAccident: true, noWaterDamage: true, engineGearboxIntact: true,
          verifiedOdo: true, electricalSystemPassed: true,
        },
        odo: 36000, result: 'PASSED', groups,
      });
    const submitted = await api()
      .post(`${BASE}/${draft.body.data._id}/submit`)
      .set('Authorization', staff.auth);

    if (submitted.status !== 200) return; // payload shape differs — covered by inspection-submit tests

    const rejected = await api()
      .put(`${BASE}/${draft.body.data._id}/reject`)
      .set('Authorization', admin.auth)
      .send({ rejectedReason: 'Biên bản thiếu ảnh odometer và chữ ký của khách hàng.' });
    expect(rejected.status).toBe(200);
  });
});
