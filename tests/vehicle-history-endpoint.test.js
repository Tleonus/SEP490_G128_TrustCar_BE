/**
 * @file vehicle-history-endpoint.test.js
 * @description KAN-98 — public history PDF and verify endpoints.
 */

import request from 'supertest';
import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';
import { buildHistoryVerifyHash } from '../src/services/vehicleHistoryService.js';

const h = await setupInspectionHarness();
const api = () => request(h.app);

const CODE = 'CPO-20261201-A1B2';
const VEHICLE_CODE = 'TC-2026-0042';

let inspector;

const certifiedCar = (carOverrides = {}, recordOverrides = {}) => {
  const carId = h.createCar({
    status: 'APPROVED_CPO',
    cpoCertificateId: CODE,
    vehicleCode: VEHICLE_CODE,
    mileage: 44950,
    make: 'VINFAST',
    model: 'VF 8',
    variant: 'Plus',
    year: 2023,
    previousOwnersCount: 2,
    ...carOverrides,
  });
  h.insertRecord({
    carId,
    status: 'SUBMITTED',
    source: 'STAFF',
    result: 'PASSED',
    cpoCertificateId: CODE,
    odo: 44950,
    inspectorId: inspector.id,
    submittedBy: inspector.id,
    submittedAt: new Date('2026-12-01T08:00:00Z'),
    vehicleInfo: { confirmed: { make: 'VINFAST', model: 'VF 8', variant: 'Plus', color: 'Trang', year: 2023, mileage: 44950 } },
    criteria: {
      noMajorAccident: true, noWaterDamage: true, engineGearboxIntact: true, verifiedOdo: true, electricalSystemPassed: true,
    },
    groups: [],
    ...recordOverrides,
  });
  return carId;
};

beforeEach(async () => {
  h.reset();
  process.env.VERIFY_HASH_SECRET = 'test-secret';
  const { id } = await h.createUser({ roleName: 'SALES_STAFF', fullName: 'Nguyen Van An' });
  inspector = { id };
});

describe('GET /api/v1/public/history/:code/pdf', () => {
  test('T12 — certified car returns a PDF', async () => {
    certifiedCar();
    const res = await api().get(`/api/v1/public/history/${VEHICLE_CODE}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.body.toString('latin1').startsWith('%PDF-1.4')).toBe(true);
  });

  test('T13 — DELISTED car is a 404', async () => {
    certifiedCar({ status: 'DELISTED' });
    const res = await api().get(`/api/v1/public/history/${VEHICLE_CODE}/pdf`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('VEHICLE_HISTORY_NOT_FOUND');
  });

  test('T14 — car without a certificate is a 404', async () => {
    certifiedCar({ cpoCertificateId: null });
    const res = await api().get(`/api/v1/public/history/${VEHICLE_CODE}/pdf`);
    expect(res.status).toBe(404);
  });

  test('T15 — a car missing its hash self-heals on first read', async () => {
    const carId = certifiedCar({ historyVerifyHash: null });
    const res = await api().get(`/api/v1/public/history/${VEHICLE_CODE}/pdf`);
    expect(res.status).toBe(200);
    expect(h.car(carId).historyVerifyHash).toBe(buildHistoryVerifyHash(carId, CODE));
  });
});

describe('GET /api/v1/public/verify/:hash', () => {
  const seed = (carOverrides = {}) => {
    const carId = certifiedCar(carOverrides);
    const hash = buildHistoryVerifyHash(carId, CODE);
    h.car(carId).historyVerifyHash = hash;
    return { carId, hash };
  };

  test('T16 — a valid hash returns the summary', async () => {
    const { hash } = seed();
    const res = await api().get(`/api/v1/public/verify/${hash}`);
    expect(res.status).toBe(200);
    expect(res.body.data.verified).toBe(true);
    expect(res.body.data.pdfUrl).toContain(`/public/history/${VEHICLE_CODE}/pdf`);
    expect(res.body.data.certificate.id).toBe(CODE);
  });

  test('T17 — a malformed hash is a 404 and never touches the database', async () => {
    seed();
    h.reads.carFindOne = 0;
    for (const bad of ['abc', 'A'.repeat(24), 'g'.repeat(24)]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await api().get(`/api/v1/public/verify/${bad}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('VERIFY_NOT_FOUND');
    }
    expect(h.reads.carFindOne).toBe(0);
  });

  test('T18 — an inactive car is a 404', async () => {
    const { hash } = seed({ isActive: false });
    const res = await api().get(`/api/v1/public/verify/${hash}`);
    expect(res.status).toBe(404);
  });

  test('T19 — a sold car still verifies and reports its status', async () => {
    const { hash } = seed({ status: 'SOLD' });
    const res = await api().get(`/api/v1/public/verify/${hash}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SOLD');
  });
});
