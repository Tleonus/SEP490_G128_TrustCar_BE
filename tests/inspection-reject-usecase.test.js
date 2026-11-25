import { describe, expect, jest, test } from '@jest/globals';
import { ActivityEventType, InspectionStatus } from '../src/constants/appConstants.js';
import { createRejectInspection } from '../src/usecase/inspection/rejectInspection.js';

const inspectionId = '000000000000000000000002';
const carId = '000000000000000000000001';
const adminId = '000000000000000000000004';
const submittedBy = '000000000000000000000003';
const reason = 'Cần bổ sung ảnh đồng hồ và ghi chú kiểm định.';
const rejectedAt = new Date('2026-11-23T12:30:00.000Z');

function pendingRecord(overrides = {}) {
  return {
    id: inspectionId, carId, status: 'PENDING_APPROVAL', source: 'STAFF',
    submittedBy, submittedAt: new Date('2026-11-23T12:00:00.000Z'),
    templateSnapshot: { templateKey: 'ELECTRIC', revision: 1, groups: [] },
    answers: [{ questionId: 'q1', value: 'saved answer' }],
    groups: [{ groupKey: 'G1_BODY_FRAME', note: 'saved note', photos: ['saved-photo'] }],
    ...overrides,
  };
}

function harness({ savedRecord = pendingRecord(), auditFailure } = {}) {
  let state = { record: savedRecord, events: [] };
  let queue = Promise.resolve();
  const updateIfCurrent = jest.fn();
  const unitOfWork = {
    run: jest.fn((action) => {
      const transaction = queue.then(async () => {
        const working = structuredClone(state);
        const result = await action({
          records: {
            findById: async (id) => id === inspectionId ? working.record : null,
            updateIfCurrent: async (id, expected, changes) => {
              if (id !== inspectionId || !working.record ||
                  Object.entries(expected).some(([key, value]) => working.record[key] !== value)) return null;
              updateIfCurrent(id, expected, changes);
              working.record = { ...working.record, ...changes };
              return working.record;
            },
          },
          audit: { append: async (event) => {
            if (auditFailure) throw auditFailure;
            working.events.push(event);
          } },
        });
        state = working;
        return result;
      });
      queue = transaction.then(() => undefined, () => undefined);
      return transaction;
    }),
  };
  const reject = createRejectInspection({ unitOfWork, now: () => new Date(rejectedAt) });
  return { reject, state: () => state, unitOfWork, updateIfCurrent };
}

describe('reject inspection use case', () => {
  test('returns a pending record to DRAFT, stores rejection trace and preserves inspection answers without touching the car', async () => {
    const h = harness();

    const result = await h.reject(inspectionId, adminId, `  ${reason}  `);

    expect(result).toMatchObject({
      status: InspectionStatus.DRAFT, templateSnapshot: null,
      rejectedReason: reason, rejectedByUserId: adminId, rejectedAt, updatedBy: adminId,
      answers: pendingRecord().answers, groups: pendingRecord().groups,
    });
    expect(h.updateIfCurrent).toHaveBeenCalledWith(inspectionId, { status: 'PENDING_APPROVAL' }, expect.objectContaining({
      status: InspectionStatus.DRAFT, rejectedReason: reason, rejectedByUserId: adminId,
    }));
    expect(h.state().events).toEqual([expect.objectContaining({
      eventType: ActivityEventType.INSPECTION_REJECTED, performedBy: adminId,
      targetModel: 'InspectionRecord', targetId: inspectionId,
      metadata: expect.objectContaining({
        carId, reason, fromStatus: 'PENDING_APPROVAL', toStatus: InspectionStatus.DRAFT,
      }),
    })]);
  });

  test.each([
    [InspectionStatus.DRAFT, 'INSPECTION_NOT_PENDING_APPROVAL'],
    [InspectionStatus.SUBMITTED, 'INSPECTION_NOT_PENDING_APPROVAL'],
  ])('does not reject a %s record', async (status, code) => {
    const original = pendingRecord({ status });
    const h = harness({ savedRecord: original });

    await expect(h.reject(inspectionId, adminId, reason)).rejects.toMatchObject({ code });
    expect(h.state().record).toEqual(original);
    expect(h.updateIfCurrent).not.toHaveBeenCalled();
    expect(h.state().events).toEqual([]);
  });

  test('validates ID, existence and a trimmed 10–1000 character reason before writing', async () => {
    const h = harness();

    await expect(h.reject('bad-id', adminId, reason)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(h.reject(inspectionId, adminId, ' too short ')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(h.reject(inspectionId, adminId, 'x'.repeat(1001))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(h.reject('000000000000000000000099', adminId, reason)).rejects.toMatchObject({ code: 'INSPECTION_NOT_FOUND' });
    expect(h.updateIfCurrent).not.toHaveBeenCalled();
    expect(h.state().events).toEqual([]);
  });

  test('only one of two concurrent rejections succeeds', async () => {
    const h = harness();

    const results = await Promise.allSettled([
      h.reject(inspectionId, adminId, reason), h.reject(inspectionId, adminId, reason),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected').map(({ reason: error }) => error.code))
      .toEqual(['INSPECTION_NOT_PENDING_APPROVAL']);
    expect(h.state().events).toHaveLength(1);
  });

  test('rolls back the rejection when audit persistence fails', async () => {
    const h = harness({ auditFailure: new Error('audit failed') });
    const before = h.state();

    await expect(h.reject(inspectionId, adminId, reason)).rejects.toThrow('audit failed');

    expect(h.state()).toEqual(before);
  });
});
