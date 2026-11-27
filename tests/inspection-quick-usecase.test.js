import { expect, jest, test } from '@jest/globals';
import { ActivityEventType, CarStatus, InspectionStatus, Permissions, Roles } from '../src/constants/appConstants.js';
import { CPO_CRITERIA } from '../src/domain/inspection/criteria.js';
import { createQuickInspection } from '../src/usecase/inspection/quickInspection.js';

const carId = 'abcdef000000000000000001';
const recordId = 'abcdef000000000000000002';
const staffId = 'abcdef000000000000000003';
const actor = { id: staffId, roleNames: [Roles.INSPECTOR], permissions: [Permissions.INSPECTION_WRITE] };
const when = new Date('2026-11-23T15:00:00Z');
const criteria = Object.fromEntries(CPO_CRITERIA.map(({ criteriaKey }) => [criteriaKey, true]));
const photo = `https://res.cloudinary.com/example/image/upload/trustcar/inspections/quick/${carId}/front.jpg`;
const input = { criteria, odo: 70_001 };

function harness({ car = {}, open = null, failAudit, failInsert, claimLost, collisions = 0 } = {}) {
  let state = {
    car: { id: carId, status: CarStatus.UNDER_INSPECTION, mileage: 70_000, updatedAt: new Date(0), ...car },
    records: [], events: [],
  };
  const calls = [];
  let sequence = 0;
  const generateCpoCertificate = jest.fn(() => `CPO-20261123-AA0${sequence++}`);
  const run = jest.fn(async (action) => {
    const working = structuredClone(state);
    const result = await action({
      cars: {
        findById: async (id) => id === carId ? { ...working.car } : null,
        claimForInspection: async (id, expected) => {
          calls.push('claim');
          if (claimLost || id !== carId || expected.updatedAt !== working.car.updatedAt) return null;
          working.car.updatedAt = new Date(expected.updatedAt.getTime() + 1);
          return { ...working.car };
        },
        updateIfCurrent: async (id, expected, fields) => {
          calls.push('write car');
          if (id !== carId || expected.updatedAt !== working.car.updatedAt) return null;
          if (collisions > 0 && fields.cpoCertificateId) {
            collisions -= 1;
            throw Object.assign(new Error('duplicate certificate'), { code: 'DUPLICATE_CERTIFICATE' });
          }
          Object.assign(working.car, fields);
          return { ...working.car };
        },
      },
      records: {
        findOpenByCarId: async () => {
          calls.push('read open record');
          return open;
        },
        insert: async (fields) => {
          if (failInsert) throw failInsert;
          const record = { ...fields, id: recordId };
          working.records.push(record);
          return record;
        },
      },
      audit: { append: async (entry) => {
        if (failAudit && working.events.length === 1) throw failAudit;
        working.events.push(entry);
      } },
    });
    state = working;
    return result;
  });
  return {
    inspect: createQuickInspection({
      unitOfWork: { run },
      isQuickInspectionImageUrl: (url, id) => id === carId && url === photo,
      generateCpoCertificate,
      buildHistoryVerifyHash: (_id, code) => `hash-${code}`,
      isCertificateCollision: (error) => error.code === 'DUPLICATE_CERTIFICATE',
      now: () => when,
    }),
    state: () => state, calls, run, generateCpoCertificate,
  };
}

test.each([CarStatus.UNDER_INSPECTION, CarStatus.APPROVED_CPO])('applies an immediate verdict for %s', async (status) => {
  const h = harness({ car: { status } });
  const result = await h.inspect(carId, actor, { ...input, notes: '  Checked  ', evidenceImages: [photo] });
  const code = 'CPO-20261123-AA00';
  expect(h.calls).toEqual(['claim', 'read open record', 'write car']);
  expect(result).toMatchObject({
    car: { status: CarStatus.APPROVED_CPO, mileage: input.odo, cpoCertificateId: code, historyVerifyHash: `hash-${code}` },
    inspectionRecord: {
      id: recordId, carId, status: InspectionStatus.SUBMITTED, source: 'ADMIN_QUICK', result: 'PASSED',
      criteria, odo: input.odo, evidenceImages: [photo], notes: 'Checked', cpoCertificateId: code,
      inspectorId: staffId, submittedBy: staffId, submittedAt: when,
    },
  });
  expect(result.inspectionRecord).not.toHaveProperty('approvedBy');
  expect(result.inspectionRecord).not.toHaveProperty('approvedAt');
  expect(h.state().events).toMatchObject([
    { eventType: ActivityEventType.INSPECTION_SUBMITTED, metadata: { inspectionId: recordId, carId, cpoCertificateId: code } },
    { eventType: ActivityEventType.CAR_STATUS_CHANGED, changes: { before: { status }, after: { status: CarStatus.APPROVED_CPO } } },
  ]);
});

test('accepts an inspection without photos, rejects the car for one false criterion, and clears certification', async () => {
  const h = harness({ car: { cpoCertificateId: 'old', historyVerifyHash: 'old-hash' } });
  const result = await h.inspect(carId, actor, { ...input, criteria: { ...criteria, verifiedOdo: false } });
  expect(result).toMatchObject({
    car: { status: CarStatus.REJECTED, cpoCertificateId: null, historyVerifyHash: null },
    inspectionRecord: { result: 'FAILED', evidenceImages: [], cpoCertificateId: null },
  });
  expect(h.generateCpoCertificate).not.toHaveBeenCalled();
});

test.each([
  [InspectionStatus.DRAFT, 'INSPECTION_DRAFT_EXISTS'],
  ['PENDING_APPROVAL', 'INSPECTION_PENDING_APPROVAL'],
])('blocks an open %s record and includes its ID', async (status, code) => {
  const h = harness({ open: { id: recordId, status } });
  const before = h.state();
  await expect(h.inspect(carId, actor, input)).rejects.toMatchObject({
    code, errors: [{ field: 'inspectionId', message: recordId }],
  });
  expect(h.calls).toEqual(['claim', 'read open record']);
  expect(h.state()).toEqual(before);
  expect(h.generateCpoCertificate).not.toHaveBeenCalled();
});

test('checks effective write permission before reading or writing the car', async () => {
  const h = harness();
  await expect(h.inspect(carId, {
    ...actor, roleNames: [Roles.SALES_STAFF], permissions: [Permissions.INSPECTION_READ],
  }, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(h.run).not.toHaveBeenCalled();
});

test('reports invalid criteria, mileage and evidence fields before a transaction', async () => {
  const h = harness();
  await expect(h.inspect(carId, actor, {
    criteria: { ...criteria, verifiedOdo: 'true' }, odo: -1, evidenceImages: [photo, 'https://example.test/other.jpg'],
  })).rejects.toMatchObject({
    code: 'VALIDATION_ERROR',
    errors: [expect.objectContaining({ field: 'criteria.verifiedOdo' }), expect.objectContaining({ field: 'odo' }),
      expect.objectContaining({ field: 'evidenceImages.1' })],
  });
  expect(h.run).not.toHaveBeenCalled();
});

test.each([
  [{ car: { status: CarStatus.AVAILABLE } }, input, 'INVALID_CAR_STATUS'],
  [{ claimLost: true }, input, 'INVALID_CAR_STATUS'],
  [{}, { ...input, odo: 69_999 }, 'MILEAGE_DECREASE'],
])('leaves the car unchanged for an ineligible status, lost claim or lower mileage', async (options, payload, code) => {
  const h = harness(options);
  const before = h.state();
  await expect(h.inspect(carId, actor, payload)).rejects.toMatchObject({ code });
  expect(h.state()).toEqual(before);
});

test.each([
  { failInsert: new Error('storage failed') }, { failAudit: new Error('storage failed') },
])('rolls back the car, record and audit if persistence fails', async (options) => {
  const h = harness(options);
  const before = h.state();
  await expect(h.inspect(carId, actor, input)).rejects.toThrow('storage failed');
  expect(h.state()).toEqual(before);
  expect(h.run).toHaveBeenCalledTimes(1);
});

test('can use a new certificate code after a collision', async () => {
  const h = harness({ collisions: 1 });
  const { car } = await h.inspect(carId, actor, input);
  expect(h.run).toHaveBeenCalledTimes(2);
  expect(car.cpoCertificateId).toBe('CPO-20261123-AA01');
  expect(h.state().records).toHaveLength(1);
});

test('fails atomically when no certificate can be allocated', async () => {
  const h = harness({ collisions: 3 });
  const before = h.state();
  await expect(h.inspect(carId, actor, input)).rejects.toMatchObject({ code: 'CPO_CODE_GENERATION_FAILED' });
  expect(h.generateCpoCertificate).toHaveBeenCalledTimes(3);
  expect(h.state()).toEqual(before);
});
