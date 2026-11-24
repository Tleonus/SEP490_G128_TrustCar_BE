import { expect, jest, test } from '@jest/globals';
import { ActivityEventType, CarStatus, InspectionStatus, Permissions, Roles } from '../src/constants/appConstants.js';
import { CPO_CRITERIA, InspectionResult } from '../src/domain/inspection/criteria.js';
import { QuestionType } from '../src/domain/inspection/formDefinition.js';
import { listRecordImages } from '../src/services/inspectionSubmitRules.js';
import { createApproveInspection } from '../src/usecase/inspection/approveInspection.js';
import { createRejectInspection } from '../src/usecase/inspection/rejectInspection.js';

const inspectionId = '000000000000000000000001';
const carId = '000000000000000000000002';
const staffId = 'abcdef000000000000000003';
const admin = {
  id: '000000000000000000000004',
  roleNames: [Roles.SALES_STAFF, Roles.ADMIN],
  permissions: [Permissions.INSPECTION_READ, Permissions.INSPECTION_ADMIN],
};
const approvedAt = new Date('2026-11-23T15:00:00Z');
const firstCode = 'CPO-20261123-AB00';
const photo = (name) => `https://images.example.test/inspections/${inspectionId}/${name}.jpg`;
const collision = () => Object.assign(new Error('duplicate certificate'), { code: 'DUPLICATE_CERTIFICATE' });

function pendingRecord(overrides = {}) {
  const groups = CPO_CRITERIA.map((criterion) => ({
    ...criterion,
    questions: [{
      id: criterion.key, label: 'Kết quả', required: true, type: QuestionType.SINGLE_CHOICE,
      config: { options: [
        { id: 'pass', label: 'Đạt', result: InspectionResult.PASS },
        { id: 'unchecked', label: 'Chưa kiểm tra', result: InspectionResult.NOT_CHECKABLE },
      ] },
    }],
  }));
  groups[0].questions.push({
    id: 'body-photo', label: 'Ảnh thân vỏ', required: true, type: QuestionType.IMAGE,
    config: { minCount: 1, maxCount: 3 },
  });

  return {
    id: inspectionId, carId, status: 'PENDING_APPROVAL',
    submittedBy: staffId, inspectorId: staffId, submittedAt: new Date('2026-11-23T14:00:00Z'),
    templateSnapshot: { templateKey: 'ELECTRIC', revision: 2, groups },
    answers: [
      ...CPO_CRITERIA.map(({ key }) => ({ questionId: key, value: 'pass' })),
      { questionId: 'body-photo', value: [photo('body'), photo('detail')] },
    ],
    vehicleInfo: { confirmed: { mileage: 51_000 } },
    groups: CPO_CRITERIA.map(({ key }, i) => (
      i === 0 ? { groupKey: key, note: '  Đã kiểm tra  ', photos: [photo('body')] } : { groupKey: key }
    )),
    overviewPhotos: { FRONT: photo('front') },
    ...overrides,
  };
}

function harness({ record = pendingRecord(), car = {}, collisions = 0, failAudit, recordConflict, carConflict } = {}) {
  let state = {
    record,
    car: { id: carId, vehicleCode: 'TC-2026-0001', status: CarStatus.UNDER_INSPECTION, mileage: 50_000, ...car },
    events: [],
  };
  let queue = Promise.resolve();
  const audit = jest.fn(async (working, event) => {
    if (failAudit && working.events.length === 1) throw failAudit;
    working.events.push(event);
  });
  const run = jest.fn((action) => {
    const transaction = queue.then(async () => {
      const working = structuredClone(state);
      const output = await action({
        records: {
          findById: async (id) => id === working.record.id ? working.record : null,
          updateIfCurrent: async (id, expected, changes) => {
            if (recordConflict || id !== working.record.id || expected.status !== working.record.status) return null;
            return Object.assign(working.record, changes);
          },
        },
        cars: {
          findById: async (id) => id === working.car.id ? { ...working.car } : null,
          updateIfCurrent: async (id, expected, changes) => {
            if (carConflict || id !== working.car.id || expected.status !== working.car.status) return null;
            if (changes.cpoCertificateId && collisions > 0) {
              collisions -= 1;
              throw collision();
            }
            return Object.assign(working.car, changes);
          },
        },
        audit: { append: (event) => audit(working, event) },
      });
      state = working;
      return output;
    });
    queue = transaction.then(() => undefined, () => undefined);
    return transaction;
  });
  let sequence = 0;
  const generate = jest.fn(() => `CPO-20261123-AB0${sequence++}`);
  const unitOfWork = { run };
  return {
    approve: createApproveInspection({
      unitOfWork,
      generateCpoCertificate: generate,
      buildHistoryVerifyHash: (_id, code) => `hash-for-${code}`,
      listRecordImages,
      isCertificateCollision: (error) => error.code === 'DUPLICATE_CERTIFICATE',
      now: () => approvedAt,
    }),
    reject: createRejectInspection({ unitOfWork }),
    state: () => state,
    run, generate, audit,
  };
}

test('approves from the stored form and answers, updates the car and records both audit events', async () => {
  const h = harness();
  const { car, inspectionRecord } = await h.approve(inspectionId, admin);

  expect(inspectionRecord).toMatchObject({
    status: InspectionStatus.SUBMITTED, result: 'PASSED', odo: 51_000,
    approvedBy: admin.id, approvedAt, updatedBy: admin.id, submittedBy: staffId, inspectorId: staffId,
    cpoCertificateId: firstCode, templateSnapshot: { revision: 2 },
    evidenceImages: [photo('front'), photo('body'), photo('detail')],
  });
  expect(inspectionRecord.criteria).toEqual(Object.fromEntries(CPO_CRITERIA.map(({ criteriaKey }) => [criteriaKey, true])));
  expect(inspectionRecord.groups.every(({ passed }) => passed)).toBe(true);
  expect(inspectionRecord.notes).toBe(`${CPO_CRITERIA[0].label}: Đã kiểm tra`);
  expect(car).toMatchObject({
    status: CarStatus.APPROVED_CPO, mileage: 51_000, cpoCertificateId: firstCode, historyVerifyHash: `hash-for-${firstCode}`,
  });
  expect(h.state().events).toMatchObject([
    {
      eventType: ActivityEventType.INSPECTION_SUBMITTED, performedBy: admin.id,
      metadata: { action: 'APPROVE', inspectionId, carId, result: 'PASSED', cpoCertificateId: firstCode },
    },
    {
      eventType: ActivityEventType.CAR_STATUS_CHANGED, performedBy: admin.id,
      changes: { before: { status: CarStatus.UNDER_INSPECTION }, after: { status: CarStatus.APPROVED_CPO } },
    },
  ]);
});

test('finalizes NOT_CHECKABLE as failed and preserves a higher current car mileage', async () => {
  const record = pendingRecord();
  record.answers[2].value = 'unchecked';
  record.groups[2].note = 'Chưa thể kiểm tra.';
  const h = harness({ record, car: { mileage: 52_000, cpoCertificateId: 'old', historyVerifyHash: 'old-hash' } });
  const { car, inspectionRecord } = await h.approve(inspectionId, admin);

  expect(inspectionRecord).toMatchObject({
    result: 'FAILED', odo: 51_000, cpoCertificateId: null, criteria: { engineGearboxIntact: false },
  });
  expect(inspectionRecord.groups[2].passed).toBe(false);
  expect(car).toMatchObject({ status: CarStatus.REJECTED, mileage: 52_000, cpoCertificateId: null, historyVerifyHash: null });
  expect(h.generate).not.toHaveBeenCalled();
});

test.each([
  { ...admin, roleNames: [Roles.SALES_STAFF, Roles.INSPECTOR] },
  { ...admin, permissions: [Permissions.INSPECTION_READ] },
])('requires both the ADMIN role and its effective inspection permission', async (actor) => {
  const h = harness();
  await expect(h.approve(inspectionId, actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(h.run).not.toHaveBeenCalled();
});

test('blocks the original submitter even after obtaining ADMIN and changing ID casing', async () => {
  const h = harness();
  await expect(h.approve(inspectionId, { ...admin, id: staffId.toUpperCase() }))
    .rejects.toMatchObject({ code: 'INSPECTION_SELF_APPROVAL' });
  expect(h.state().record.status).toBe('PENDING_APPROVAL');
  expect(h.generate).not.toHaveBeenCalled();
});

test.each([InspectionStatus.DRAFT, InspectionStatus.SUBMITTED])('cannot approve %s', async (status) => {
  const h = harness({ record: pendingRecord({ status }) });
  await expect(h.approve(inspectionId, admin)).rejects.toMatchObject({ code: 'INSPECTION_NOT_PENDING_APPROVAL' });
  expect(h.generate).not.toHaveBeenCalled();
});

test('cannot approve a vehicle that left UNDER_INSPECTION', async () => {
  const h = harness({ car: { status: CarStatus.DELISTED } });
  await expect(h.approve(inspectionId, admin)).rejects.toMatchObject({ code: 'INVALID_CAR_STATUS' });
  expect(h.state().record.status).toBe('PENDING_APPROVAL');
});

test.each([false, true])('one transition wins against a concurrent approval or rejection (%s)', async (rejectFirst) => {
  const h = harness();
  const competitor = rejectFirst
    ? h.reject(inspectionId, admin.id, 'Cần bổ sung ảnh trước khi duyệt.')
    : h.approve(inspectionId, admin);
  const results = await Promise.allSettled([competitor, h.approve(inspectionId, admin)]);
  expect(results[0].status).toBe('fulfilled');
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'INSPECTION_NOT_PENDING_APPROVAL' } });
  expect(h.state().record.status).toBe(rejectFirst ? InspectionStatus.DRAFT : InspectionStatus.SUBMITTED);
  expect(h.generate).toHaveBeenCalledTimes(rejectFirst ? 0 : 1);
  expect(h.state().events).toHaveLength(rejectFirst ? 1 : 2);
});

test.each([
  [{ recordConflict: true }, { code: 'INSPECTION_NOT_PENDING_APPROVAL' }],
  [{ carConflict: true }, { code: 'INVALID_CAR_STATUS' }],
  [{ failAudit: new Error('audit write failed') }, { message: 'audit write failed' }],
])('rolls back when a conditional write loses or an audit entry fails', async (options, error) => {
  const h = harness(options);
  const before = h.state();
  await expect(h.approve(inspectionId, admin)).rejects.toMatchObject(error);
  expect(h.state()).toEqual(before);
  expect(h.run).toHaveBeenCalledTimes(1);
});

test('rolls back conflicting certificates and succeeds with a fresh code on the third attempt', async () => {
  const h = harness({ collisions: 2 });
  const { car, inspectionRecord } = await h.approve(inspectionId, admin);
  expect(h.run).toHaveBeenCalledTimes(3);
  expect(car.cpoCertificateId).toBe('CPO-20261123-AB02');
  expect(inspectionRecord.cpoCertificateId).toBe(car.cpoCertificateId);
  expect(h.state().events).toHaveLength(2);
});

test('leaves the inspection pending when all three certificate attempts collide', async () => {
  const h = harness({ collisions: 3 });
  const before = h.state();
  await expect(h.approve(inspectionId, admin)).rejects.toMatchObject({ code: 'CPO_CODE_GENERATION_FAILED' });
  expect(h.generate).toHaveBeenCalledTimes(3);
  expect(h.state()).toEqual(before);
});
