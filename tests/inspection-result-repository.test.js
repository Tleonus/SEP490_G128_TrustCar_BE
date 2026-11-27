import { describe, expect, jest, test } from '@jest/globals';
import InspectionResult from '../src/infra/inspection/inspectionResultModel.js';
import { createInspectionResultRepository } from '../src/infra/inspection/inspectionResultRepository.js';

const inspectionId = '000000000000000000000123';
const criterionId = 'BODYWORK';
const score = { criterionId, outcome: 'PASS' };

function createHarness(overrides = {}) {
  const session = { inTransaction: () => true };
  const record = {
    status: 'DRAFT', templateKey: 'GASOLINE', checklistVersion: '2', updatedAt: new Date(), ...overrides,
  };
  const rows = new Map();
  const recordModel = {
    findById: jest.fn(() => ({ lean: async () => ({ ...record }) })),
    updateOne: jest.fn(async (filter, { $set }) => {
      if (record.status !== filter.status || record.checklistVersion !== filter.checklistVersion ||
          record.updatedAt !== filter.updatedAt) return { matchedCount: 0 };
      Object.assign(record, $set);
      return { matchedCount: 1 };
    }),
  };
  const template = { format: 'CRITERIA', groups: [{ key: criterionId, label: 'Thân vỏ', required: true }] };
  const templates = { findRevision: jest.fn().mockResolvedValue(template) };
  const model = {
    findOneAndUpdate: jest.fn((key, { $set }) => ({
      lean: async () => {
        const row = { ...key, ...$set };
        rows.set(`${key.inspectionId}:${key.criterionId}`, row);
        return row;
      },
    })),
    find: jest.fn(() => ({ sort: jest.fn(() => ({ lean: async () => [...rows.values()] })) })),
  };

  const results = createInspectionResultRepository({ session, templates, model, recordModel });
  return { record, recordModel, templates, template, model, results, session };
}

describe('Separate inspection results', () => {
  test('uses a unique inspection and criterion pair with a valid outcome', async () => {
    expect(InspectionResult.collection.name).toBe('inspection_results');
    expect(InspectionResult.schema.indexes()).toContainEqual([
      { inspectionId: 1, criterionId: 1 }, expect.objectContaining({ unique: true }),
    ]);
    await expect(new InspectionResult({ inspectionId, ...score }).validate()).resolves.toBeUndefined();
    await expect(new InspectionResult({ inspectionId, ...score, outcome: 'UNKNOWN' }).validate())
      .rejects.toThrow('outcome');
  });

  test('uses one row per pair and updates the draft and score in the same transaction', async () => {
    const { record, recordModel, templates, model, results, session } = createHarness();
    const previousUpdate = record.updatedAt;
    await expect(results.saveDraftResult(inspectionId, 2, score)).resolves.toMatchObject(score);
    expect(record.updatedAt.getTime()).toBeGreaterThan(previousUpdate.getTime());
    const revisedScore = { ...score, outcome: 'FAIL', evidenceImages: ['https://example.test/body.jpg'] };
    await expect(results.saveDraftResult(inspectionId, 2, revisedScore)).resolves.toMatchObject(revisedScore);
    expect(templates.findRevision).toHaveBeenCalledWith('GASOLINE', 2);
    expect(recordModel.updateOne).toHaveBeenCalledWith(expect.objectContaining({
      _id: inspectionId, status: 'DRAFT', templateKey: 'GASOLINE', checklistVersion: '2', updatedAt: previousUpdate,
    }), { $set: { updatedAt: expect.any(Date) } }, { session, timestamps: false });
    expect(model.findOneAndUpdate).toHaveBeenCalledWith({ inspectionId, criterionId }, expect.any(Object),
      { session, new: true, upsert: true, runValidators: true });
    await expect(results.findByInspectionId(inspectionId)).resolves.toEqual([
      { inspectionId, ...revisedScore, note: '' },
    ]);
  });

  test('refuses stale revisions and criterion IDs outside the saved revision', async () => {
    const { results, recordModel, model } = createHarness();
    await expect(results.saveDraftResult(inspectionId, 1, score)).rejects.toMatchObject({
      code: 'FORM_REVISION_CONFLICT',
    });
    await expect(results.saveDraftResult(inspectionId, 2, { ...score, criterionId: 'NOT_ON_FORM' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(results.saveDraftResult(inspectionId, 2, { criterionId }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(recordModel.updateOne).not.toHaveBeenCalled();
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('refuses pending records and stops before upsert if another write wins the lock', async () => {
    const pending = createHarness({ status: 'PENDING_APPROVAL' });
    await expect(pending.results.saveDraftResult(inspectionId, 2, score)).rejects.toMatchObject({
      code: 'INSPECTION_LOCKED',
    });
    expect(pending.recordModel.updateOne).not.toHaveBeenCalled();
    const draft = createHarness();
    draft.recordModel.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
    await expect(draft.results.saveDraftResult(inspectionId, 2, score)).rejects.toMatchObject({
      code: 'INSPECTION_LOCKED',
    });
    expect(draft.model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('keeps legacy templates and writes without a transaction out of the new result path', async () => {
    const { results, model, session, templates } = createHarness();
    templates.findRevision.mockResolvedValue({ groups: [] });
    await expect(results.saveDraftResult(inspectionId, 2, score)).rejects.toMatchObject({
      code: 'INSPECTION_TEMPLATE_NOT_AVAILABLE',
    });
    session.inTransaction = () => false;
    await expect(results.saveDraftResult(inspectionId, 2, score)).rejects.toThrow('active transaction');
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
