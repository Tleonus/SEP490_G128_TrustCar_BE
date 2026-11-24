import request from 'supertest';
import { CPO_CRITERIA } from '../src/domain/inspection/criteria.js';
import { PUBLIC_REPORT_SCOPE_NOTE } from '../src/config/inspectionChecklist.js';
import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';

const h = await setupInspectionHarness();
const api = () => request(h.app);
const inspections = '/api/v1/inspections';
const publicReport = (carKey) => api().get(`/api/v1/public/cars/${carKey}/inspection-report`);
const passedGroups = CPO_CRITERIA.map(({ key, label }) => ({
  key, label, passed: true, items: [], photos: [], minorDefects: [],
}));

// Each test seeds a single certificate per car. Reuse the fake's equality
// matching for the report repository's alternatives for finalized status.
const findOneRecord = h.InspectionRecord.findOne.getMockImplementation();
h.InspectionRecord.findOne.mockImplementation(({ $or, ...filter }, ...args) => {
  if (!$or) return findOneRecord(filter, ...args);
  const query = {
    sort: () => query,
    async lean() {
      const matches = await Promise.all($or.map((status) => findOneRecord({ ...filter, ...status }, ...args).lean()));
      return matches.find(Boolean) ?? null;
    },
  };
  return query;
});

beforeEach(() => h.reset());

test.each(['GASOLINE', 'ELECTRIC'])('publishes only the approved CPO result for a %s form', async (fuelType) => {
  const inspector = await h.loginAs('INSPECTOR');
  const staff = await h.loginAs('SALES_STAFF');
  const admin = await h.loginAs('ADMIN');
  h.stored(staff.id).fullName = 'Nguyễn Văn An';
  const templateUrl = `${inspections}/form-templates/${fuelType}`;
  const { body: { data: initial } } = await api().get(templateUrl).set('Authorization', admin.auth).expect(200);
  const imageQuestion = {
    id: `${fuelType}-evidence-photo`,
    label: 'Ảnh chẩn đoán nội bộ',
    type: 'IMAGE',
    required: false,
    config: { minCount: 0, maxCount: 1 },
  };
  const groupsWithEvidence = initial.groups.map((group, index) => index === 0
    ? { ...group, questions: [...group.questions, imageQuestion] }
    : group);
  const { body: { data: form } } = await api().put(templateUrl).set('Authorization', admin.auth)
    .send({ baseRevision: initial.revision, groups: groupsWithEvidence }).expect(200);
  expect(form).toMatchObject({ templateKey: fuelType, revision: 2 });

  const vehicleCode = 'TC-2026-0052';
  const carId = h.createCar({ fuelType, vehicleCode, status: 'INCOMING', mileage: 48000 });
  const { body: { data: draft } } = await api().post(`${inspections}/cars/${carId}/draft`)
    .set('Authorization', inspector.auth).expect(201);
  const inspectionUrl = `${inspections}/${draft._id}`;
  const photo = (name) => `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/v1/trustcar/inspections/${draft._id}/${name}.jpg`;
  const imageAnswer = { questionId: imageQuestion.id, value: [photo('internal-form-evidence')] };
  const confirmed = { make: 'TOYOTA', model: 'Vios', variant: '1.5G', color: 'Trắng', year: 2020, mileage: 50000 };
  const { body: { data: filled } } = await api().patch(inspectionUrl).set('Authorization', inspector.auth)
    .send({
      baseRevision: form.revision,
      vehicleInfo: { confirmed },
      answers: [...form.groups.map(({ questions }) => ({ questionId: questions[0].id, value: 'pass' })), imageAnswer],
      overviewPhotos: Object.fromEntries(['FRONT', 'REAR', 'LEFT', 'RIGHT'].map((side) => [side, photo(side)])),
      groups: form.groups.map(({ key }) => ({
        groupKey: key,
        note: 'Ghi chú kỹ thuật nội bộ',
        photos: [photo(key)],
        ...(key === 'G4_ODOMETER' ? { odometerPhoto: photo('odometer') } : {}),
      })),
    }).expect(200);
  expect(filled.answers).toContainEqual(imageAnswer);

  const { body: { data: pending } } = await api().post(`${inspectionUrl}/submit`).set('Authorization', staff.auth)
    .send({ baseRevision: form.revision }).expect(200);
  expect(pending).toMatchObject({ status: 'PENDING_APPROVAL', submittedBy: staff.id, cpoCertificateId: null });
  const awaitingApproval = await publicReport(carId).expect(404);
  expect(awaitingApproval.body.code).toBe('INSPECTION_REPORT_NOT_FOUND');

  const { body: { data: issued } } = await api().post(`${inspectionUrl}/approve`).set('Authorization', admin.auth).expect(200);
  const certificateId = issued.car.cpoCertificateId;
  expect(certificateId).toMatch(/^CPO-/);
  expect(issued.inspectionRecord).toMatchObject({
    status: 'SUBMITTED',
    result: 'PASSED',
    cpoCertificateId: certificateId,
    checklistSnapshot: { templateKey: fuelType, revision: form.revision },
  });

  const { body: published } = await publicReport(vehicleCode).expect(200);
  expect(published).toEqual({
    success: true,
    message: 'Inspection report retrieved successfully.',
    data: {
      certificateId,
      issuedAt: pending.submittedAt,
      level: 'FULL',
      inspector: 'N.V.A.',
      vehicle: confirmed,
      groups: passedGroups,
      overviewPhotos: null,
      photos: [],
      scopeNote: PUBLIC_REPORT_SCOPE_NOTE,
    },
  });
  const revisedGroups = form.groups.map((group, index) => index === 0
    ? { ...group, questions: [{ ...group.questions[0], label: 'Nhãn câu hỏi sau khi cấp chứng nhận' }] }
    : group);
  const { body: { data: revised } } = await api().put(templateUrl).set('Authorization', admin.auth)
    .send({ baseRevision: form.revision, groups: revisedGroups }).expect(200);
  expect(revised.revision).toBe(form.revision + 1);
  expect(revised.groups[0].questions).toHaveLength(1);

  const { body: reread } = await publicReport(carId).expect(200);
  expect(reread).toEqual(published);
});

test('serves a legacy certificate in the same public format by reading its saved flags', async () => {
  const certificateId = 'CPO-20250902-0015';
  const issuedAt = '2025-09-02T08:15:00.000Z';
  const carId = h.createCar({ status: 'AVAILABLE', cpoCertificateId: certificateId, mileage: 72000 });
  h.insertRecord({
    carId,
    cpoCertificateId: certificateId,
    result: 'PASSED',
    createdAt: new Date(issuedAt),
    odo: 65000,
    criteria: { noMajorAccident: true, noWaterDamage: false, verifiedOdo: true },
    notes: 'Ghi chú từ biên bản cũ',
    evidenceImages: ['https://example.test/internal-legacy-evidence.jpg'],
  });

  const { body } = await publicReport(carId).expect(200);
  expect(body.data).toEqual({
    certificateId,
    issuedAt,
    level: 'MINIMAL',
    inspector: null,
    vehicle: { make: 'TOYOTA', model: 'Vios', variant: '1.5G', color: 'Trắng', year: 2020, mileage: 65000 },
    overviewPhotos: null,
    groups: [passedGroups[0], passedGroups[3]],
    photos: [],
    scopeNote: PUBLIC_REPORT_SCOPE_NOTE,
  });
});
