/**
 * @file public-inspection-report.test.js
 * @description Integration tests (real app, in-memory persistence) for the public
 * CPO inspection report: GET /api/v1/public/cars/:id/inspection-report.
 */

import request from 'supertest';
import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';
import {
  CRITERIA_REPORT_SCOPE_NOTE, getChecklist, PUBLIC_REPORT_SCOPE_NOTE,
} from '../src/config/inspectionChecklist.js';

const h = await setupInspectionHarness();

const api = () => request(h.app);
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME;
const CODE = 'CPO-20261102-3F9A';
const allTrue = {
  noMajorAccident: true, noWaterDamage: true, engineGearboxIntact: true, verifiedOdo: true, electricalSystemPassed: true,
};
const img = (folder, name) => `https://res.cloudinary.com/${CLOUD}/image/upload/v1/${folder}/${name}.jpg`;
const report = (idOrCode) => api().get(`/api/v1/public/cars/${idOrCode}/inspection-report`);
const reportNotFound = {
  success: false, code: 'INSPECTION_REPORT_NOT_FOUND', message: 'Inspection report not found.',
};
const passedGroups = [
  ['G1_BODY_FRAME', 'Khung gầm, thân vỏ không đâm va'],
  ['G2_FLOOD', 'Không ngập nước, thủy kích'],
  ['G3_ENGINE_GEARBOX', 'Động cơ, hộp số nguyên bản'],
  ['G4_ODOMETER', 'ODO chuẩn, không tua'],
  ['G5_ELECTRICAL_SAFETY', 'Điện tử, an toàn hoạt động tốt'],
].map(([key, label]) => ({ key, label, passed: true, items: [], photos: [], minorDefects: [] }));

let inspector;

/** A certified car with a digital-checklist record (source STAFF). */
const certifiedCar = (carOverrides = {}, recordOverrides = {}) => {
  const carId = h.createCar({ status: 'AVAILABLE', cpoCertificateId: CODE, mileage: 40000, ...carOverrides });
  const recordId = h.insertRecord({
    carId,
    status: 'SUBMITTED',
    source: 'STAFF',
    checklistVersion: '1.0',
    result: 'PASSED',
    cpoCertificateId: CODE,
    criteria: allTrue,
    odo: 50000,
    inspectorId: inspector.id,
    submittedBy: inspector.id,
    submittedAt: new Date('2026-11-02T08:15:00Z'),
    notes: 'Ghi chú nội bộ',
    createdBy: inspector.id,
    checklistSnapshot: { templateKey: 'GASOLINE', revision: 1, groups: [{ label: 'Tên nội bộ' }] },
    answers: [{ questionId: 'internal-photo', value: [img('trustcar/inspections/r', 'answer')] }],
    archivedAnswers: [{ questionId: 'old-answer', value: 'Dữ liệu cũ nội bộ', sourceRevision: 1 }],
    vehicleInfo: {
      original: { make: 'TOYOTA', mileage: 40000 },
      confirmed: { make: 'TOYOTA', model: 'Vios', variant: '1.5G', color: 'Trắng', year: 2020, mileage: 50000 },
    },
    overviewPhotos: { FRONT: img('trustcar/inspections/r', 'f'), REAR: null, LEFT: null, RIGHT: null },
    groups: getChecklist().map((def) => ({
      groupKey: def.key,
      note: 'nội bộ',
      passed: true,
      items: def.items.map((i) => ({ itemKey: i.key, result: 'PASS', note: '', photos: [] })),
      photos: [img('trustcar/inspections/r', def.key)],
      minorDefects: [],
    })),
    ...recordOverrides,
  });
  return { carId, recordId };
};

beforeEach(async () => {
  h.reset();
  const { id } = await h.createUser({ roleName: 'SALES_STAFF', fullName: 'Nguyễn Văn An' });
  inspector = { id };
});

describe('Public documents for a certified criteria revision', () => {
  function criteriaCar(revision) {
    return certifiedCar({ vehicleCode: 'TC-2026-0042', make: 'Toyota', model: 'Vios' }, {
      templateKey: 'GASOLINE', checklistVersion: String(revision), checklistSnapshot: undefined,
      criteria: undefined, vehicleInfo: undefined, groups: undefined,
    });
  }

  const oldGroup = { key: 'BODY', label: 'Than vo luc cap', required: true };
  const newGroup = { key: 'EXTRA', label: 'Tieu chi bo sung', required: false };
  const missingGroup = { key: 'OPTIONAL', label: 'Khong cong khai ket qua', required: false };
  const privateValue = 'CHI NOi BO';

  test.each([1, 2])('uses the exact certifying revision %s for JSON, certificate PDF and history PDF', async (revision) => {
    const { carId, recordId } = criteriaCar(revision);
    const published = {
      1: [oldGroup, missingGroup],
      2: [{ ...oldGroup, label: 'Than vo theo v2' }, newGroup, missingGroup],
    };
    const { headRead, aggregate } = h.mockCertificateRevisionRead(async (pipeline) => {
      const [selector] = pipeline;
      const groups = published[selector.$match.revision];
      if (!groups) return [];
      const outcomeJoin = pipeline.find((stage) => stage.$lookup?.as === 'passedResults').$lookup;
      const { inspectionId, outcome } = outcomeJoin.pipeline[0].$match;
      expect(String(inspectionId)).toBe(recordId);
      expect(outcome).toBe('PASS');
      return [{
        format: 'CRITERIA',
        groups: groups.map((group) => ({ ...group, note: privateValue })),
        passedResults: [
          ...(revision === 2 ? [{ criterionId: newGroup.key }] : []),
          { criterionId: oldGroup.key, note: privateValue, evidenceImages: [privateValue] },
          { criterionId: 'ORPHANED' },
        ],
        ...(pipeline.some((stage) => stage.$lookup?.as === 'inspectors')
          ? { inspectors: [{ fullName: 'Nguyễn Văn An', email: privateValue }] } : {}),
      }];
    });
    try {
      const expected = published[revision].filter(({ key }) => key !== missingGroup.key).map(({ key, label }) => ({
        key, label, passed: true, items: [], photos: [], minorDefects: [],
      }));
      const json = await report(carId);
      expect(json.status).toBe(200);
      expect(json.body.data).toMatchObject({
        groups: expected, vehicle: { make: 'TOYOTA', model: 'Vios', mileage: 50000 },
        inspector: 'N.V.A.', scopeNote: CRITERIA_REPORT_SCOPE_NOTE, overviewPhotos: null, photos: [],
      });
      expect(json.body.data.groups).toStrictEqual(expected);
      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(json.body)).not.toContain(privateValue);

      for (const path of [
        `/api/v1/public/cars/${carId}/cpo-certificate.pdf`, '/api/v1/public/history/TC-2026-0042/pdf',
      ]) {
        const pdf = await api().get(path);
        expect(pdf.status).toBe(200);
        const bytes = pdf.body.toString('latin1');
        expected.forEach(({ label }) => expect(bytes).toContain(label));
        expect(bytes).not.toContain(privateValue);
        expect(bytes).not.toContain(missingGroup.label);
        expect(bytes).not.toContain(revision === 1 ? newGroup.label : oldGroup.label);
      }
      expect(aggregate).toHaveBeenCalledTimes(3);
      for (const [pipeline] of aggregate.mock.calls) {
        expect(pipeline[0]).toEqual({ $match: { templateKey: 'GASOLINE', revision } });
      }
      expect(headRead).not.toHaveBeenCalled();
    } finally {
      aggregate.mockRestore();
    }
  });

  test('returns the public not-found response if a referenced revision is absent', async () => {
    const { carId } = criteriaCar(2);
    const { aggregate } = h.mockCertificateRevisionRead(async () => []);
    try {
      const result = await report(carId);
      expect(result.status).toBe(404);
      expect(result.body).toMatchObject(reportNotFound);
    } finally {
      aggregate.mockRestore();
    }
  });
});

describe('GET /api/v1/public/cars/:id/inspection-report', () => {
  test('AVAILABLE car with a checklist record → 200 FULL report, no token needed', async () => {
    const { carId } = certifiedCar();

    const res = await report(carId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Inspection report retrieved successfully.',
      data: {
        certificateId: CODE, level: 'FULL', inspector: 'N.V.A.', issuedAt: '2026-11-02T08:15:00.000Z',
        vehicle: { make: 'TOYOTA', model: 'Vios', variant: '1.5G', color: 'Trắng', year: 2020, mileage: 50000 },
        groups: passedGroups,
        overviewPhotos: null,
        photos: [],
        scopeNote: PUBLIC_REPORT_SCOPE_NOTE,
      },
    });
  });

  test('APPROVED_CPO car (not yet on sale) → 200; lookup by vehicleCode works', async () => {
    const { carId } = certifiedCar({ status: 'APPROVED_CPO', vehicleCode: 'TC-2026-0042' });

    expect((await report(carId)).status).toBe(200);
    const byCode = await report('TC-2026-0042');
    expect(byCode.status).toBe(200);
    expect(byCode.body.data.certificateId).toBe(CODE);
  });

  test('quick-inspection record → MINIMAL report', async () => {
    const { carId } = certifiedCar({}, {
      source: 'ADMIN_QUICK', groups: undefined, vehicleInfo: undefined, overviewPhotos: undefined,
      evidenceImages: [img('trustcar/inspections/quick/c', 'q')],
    });

    const res = await report(carId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      level: 'MINIMAL', overviewPhotos: null, photos: [], groups: passedGroups,
      vehicle: { make: 'TOYOTA', model: 'Vios', variant: '1.5G', color: 'Trắng', year: 2020, mileage: 50000 },
    });
  });

  test('legacy certificate uses the stored criteria and createdAt when submittedAt is missing', async () => {
    const createdAt = new Date('2026-09-01T08:00:00Z');
    const { carId, recordId } = certifiedCar({}, { status: undefined, source: undefined, submittedAt: undefined, createdAt });
    const { criteria } = h.records.get(recordId);
    criteria.noWaterDamage = false;
    delete criteria.engineGearboxIntact;
    criteria.verifiedOdo = 'true';

    const res = await report(carId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ level: 'MINIMAL', issuedAt: createdAt.toISOString() });
    expect(res.body.data.groups).toEqual([passedGroups[0], passedGroups[4]]);
  });

  test.each([
    ['REJECTED car', { status: 'REJECTED' }, {}],
    ['RESERVED car', { status: 'RESERVED' }, {}],
    ['SOLD car', { status: 'SOLD' }, {}],
    ['UNDER_INSPECTION car', { status: 'UNDER_INSPECTION' }, {}],
    ['inactive car', { isActive: false }, {}],
    ['car without certificate', { cpoCertificateId: null }, {}],
    ['record with another certificate', {}, { cpoCertificateId: 'CPO-20260101-0000' }],
    ['record for another car', {}, { carId: '65f000000000000000000099' }],
    ['record not PASSED', {}, { result: 'FAILED' }],
    ['record still a DRAFT', {}, { status: 'DRAFT' }],
    ['record awaiting approval', {}, { status: 'PENDING_APPROVAL' }],
  ])('%s → 404 INSPECTION_REPORT_NOT_FOUND', async (_label, carOverrides, recordOverrides) => {
    const { carId } = certifiedCar(carOverrides, recordOverrides);

    const res = await report(carId);

    expect(res.status).toBe(404);
    expect(res.body).toEqual(reportNotFound);
  });

  test('unknown id, unknown vehicleCode and garbage id → the same 404', async () => {
    for (const id of ['65f000000000000000000099', 'TC-2099-9999', 'abc$ne']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await report(id);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(reportNotFound);
    }
  });

  test('unknown inspector → inspector null', async () => {
    const { carId } = certifiedCar({}, { submittedBy: undefined, inspectorId: '65f0000000000000000000ee' });

    expect((await report(carId)).body.data.inspector).toBeNull();
  });

  test('a token (any role) does not change the report', async () => {
    const { carId } = certifiedCar();
    const customer = await h.loginAs('CUSTOMER');

    const anonymous = await report(carId);
    const withToken = await report(carId).set('Authorization', customer.auth);

    expect(withToken.body).toEqual(anonymous.body);
  });

  test('reads at most 3 documents per request', async () => {
    const { carId } = certifiedCar();
    const spies = [h.Car.findOne, h.InspectionRecord.findOne, h.User.findById];
    spies.forEach((spy) => spy.mockClear());

    expect((await report(carId)).status).toBe(200);

    spies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
  });

  test('unexpected query failures use the global error handler', async () => {
    const { carId } = certifiedCar();
    h.Car.findOne.mockImplementationOnce(() => { throw new Error('Simulated report lookup failure'); });

    const res = await report(carId);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, code: 'INTERNAL_ERROR' });
  });
});
