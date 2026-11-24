import { describe, expect, jest, test } from '@jest/globals';
import { ActivityEventType, CarStatus, FuelType, InspectionStatus } from '../src/constants/appConstants.js';
import { CPO_CRITERIA, InspectionResult } from '../src/domain/inspection/criteria.js';
import { QuestionType } from '../src/domain/inspection/formDefinition.js';
import { createSubmitInspection } from '../src/usecase/inspection/submitInspection.js';

const inspectionId = '000000000000000000000002';
const carId = '000000000000000000000001';
const staffId = '000000000000000000000003';
const imageBase = `https://images.example.test/inspections/${inspectionId}`;
const image = (name) => `${imageBase}/${name}.jpg`;
const submittedAt = new Date('2026-11-23T12:00:00.000Z');

function template(revision = 1, groups = CPO_CRITERIA.map((criterion) => ({
  ...criterion,
  questions: [{
    id: `score-${criterion.key}`, label: 'Kết quả', required: true, type: QuestionType.SINGLE_CHOICE,
    config: { options: [
      { id: 'pass', label: 'Đạt', result: InspectionResult.PASS },
      { id: 'fail', label: 'Không đạt', result: InspectionResult.FAIL },
      { id: 'unchecked', label: 'Chưa thể kiểm tra', result: InspectionResult.NOT_CHECKABLE },
    ] },
  }],
}))) {
  return { templateKey: FuelType.ELECTRIC, revision, groups, retiredIds: { questions: [], options: [] } };
}

function record(overrides = {}) {
  const currentTemplate = template();
  return {
    id: inspectionId, carId, status: InspectionStatus.DRAFT, source: 'STAFF',
    templateKey: FuelType.ELECTRIC, templateRevision: 1, answers: currentTemplate.groups.map(({ key }) => ({
      questionId: `score-${key}`, value: 'pass',
    })), archivedAnswers: [],
    vehicleInfo: { confirmed: {
      make: 'VinFast', model: 'VF 8', variant: 'Eco', color: 'White', year: 2025, mileage: 50_100,
    } },
    overviewPhotos: { FRONT: image('front'), REAR: image('rear'), LEFT: image('left'), RIGHT: image('right') },
    groups: currentTemplate.groups.map(({ key }) => ({
      groupKey: key, note: '', photos: [image(key)], odometerPhoto: key === 'G4_ODOMETER' ? image('odo') : null,
      items: [], minorDefects: [], passed: null,
    })),
    ...overrides,
  };
}

const car = (overrides = {}) => ({
  id: carId, status: CarStatus.UNDER_INSPECTION, fuelType: FuelType.ELECTRIC, mileage: 50_000, ...overrides,
});

function harness({ savedRecord = record(), savedCar = car(), currentTemplate = template(), history, auditFailure } = {}) {
  let state = { record: savedRecord, car: savedCar, events: [] };
  const revisions = history ?? [currentTemplate];
  const updateIfCurrent = jest.fn();
  let queue = Promise.resolve();
  const unitOfWork = {
    run: jest.fn((action) => {
      const transaction = queue.then(async () => {
        const working = structuredClone(state);
        const result = await action({
          records: {
            findById: async (id) => id === inspectionId ? working.record : null,
            updateIfCurrent: async (id, expected, changes) => {
              const current = working.record;
              if (id !== inspectionId || !current || Object.entries(expected).some(([key, value]) => current[key] !== value)) {
                return null;
              }
              const next = { ...current, ...changes };
              updateIfCurrent(id, expected, changes);
              working.record = next;
              return next;
            },
          },
          cars: { findById: async (id) => id === carId ? working.car : null },
          templates: {
            findCurrent: async (key) => key === currentTemplate.templateKey ? currentTemplate : null,
            findRevision: async (key, revision) => revisions.find((item) =>
              item.templateKey === key && item.revision === revision) ?? null,
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
  const isInspectionImageUrl = (url, id) => id === inspectionId && typeof url === 'string' && url.startsWith(`${imageBase}/`);
  const submit = createSubmitInspection({ unitOfWork, isInspectionImageUrl, now: () => new Date(submittedAt) });
  return { submit, state: () => state, unitOfWork, updateIfCurrent };
}

describe('submit inspection use case', () => {
  test('moves a complete draft to PENDING_APPROVAL and snapshots the current template without deciding the verdict or changing the car', async () => {
    const h = harness();

    const result = await h.submit(inspectionId, staffId, 1);

    expect(result).toMatchObject({
      status: 'PENDING_APPROVAL', templateRevision: 1, templateSnapshot: template(),
      submittedBy: staffId, submittedAt, updatedBy: staffId,
    });
    expect(result.answers).toEqual(record().answers);
    expect(result).not.toHaveProperty('criteria');
    expect(result).not.toHaveProperty('result');
    expect(result).not.toHaveProperty('odo');
    expect(h.state().car).toEqual(car());
    expect(h.state().events).toEqual([expect.objectContaining({
      eventType: ActivityEventType.INSPECTION_SUBMITTED, performedBy: staffId,
      targetModel: 'InspectionRecord', targetId: inspectionId,
      metadata: expect.objectContaining({ fromStatus: InspectionStatus.DRAFT, toStatus: 'PENDING_APPROVAL', templateRevision: 1 }),
    })]);
  });

  test('uses the latest form revision and requires answers added since the saved revision', async () => {
    const original = template(1);
    const latest = template(2, original.groups.map((group, index) => index === 0 ? ({
      ...group,
      questions: [...group.questions, {
        id: 'new-required', label: 'Số đo bổ sung', required: true, type: QuestionType.NUMBER,
        config: { min: 0, max: 100, integer: true, unit: 'mm' },
      }],
    }) : group));
    const h = harness({ currentTemplate: latest, history: [original, latest] });

    await expect(h.submit(inspectionId, staffId, 2)).rejects.toMatchObject({
      code: 'INSPECTION_INCOMPLETE', errors: [expect.objectContaining({ field: 'answers.new-required', code: 'REQUIRED' })],
    });
    expect(h.state().record.status).toBe(InspectionStatus.DRAFT);
    expect(h.state().record.answers).toEqual(record().answers);
    expect(h.state().events).toEqual([]);
  });

  test('projects compatible answers and archives answers removed from the current revision', async () => {
    const original = template(1, CPO_CRITERIA.map((criterion, index) => ({
      ...template().groups[index],
      questions: [...template().groups[index].questions, ...(index === 0 ? [{
        id: 'retired-question', label: 'Ghi chú cũ', required: false, type: QuestionType.TEXT,
        config: { maxLength: 80 },
      }] : [])],
    })));
    const saved = record({
      templateRevision: 1,
      answers: [...record().answers, { questionId: 'retired-question', value: 'giữ trong lịch sử' }],
    });
    const latest = template(2);
    const h = harness({ savedRecord: saved, currentTemplate: latest, history: [original, latest] });

    const result = await h.submit(inspectionId, staffId, 2);

    expect(result.archivedAnswers).toContainEqual({
      questionId: 'retired-question', value: 'giữ trong lịch sử', sourceRevision: 1,
    });
    expect(result.answers).toEqual(record().answers);
    expect(result.templateSnapshot).toEqual(latest);
  });

  test('collects all missing, invalid and failing-answer violations without writing', async () => {
    const invalid = record();
    invalid.overviewPhotos.REAR = 'https://outside.example.test/rear.jpg';
    invalid.vehicleInfo.confirmed.mileage = 49_000;
    invalid.answers[0] = { questionId: 'score-G1_BODY_FRAME', value: 'fail' };
    invalid.groups[0].note = '';
    invalid.groups[0].photos = [];
    const h = harness({ savedRecord: invalid });

    await expect(h.submit(inspectionId, staffId, 1)).rejects.toMatchObject({
      code: 'INSPECTION_INCOMPLETE',
      errors: expect.arrayContaining([
        expect.objectContaining({ field: 'overviewPhotos.REAR', code: 'INVALID_IMAGE_URL' }),
        expect.objectContaining({ field: 'vehicleInfo.confirmed.mileage', code: 'MILEAGE_DECREASE' }),
        expect.objectContaining({ field: 'groups.0.note', code: 'FAIL_NOTE_REQUIRED' }),
        expect.objectContaining({ field: 'groups.0.photos', code: 'FAIL_PHOTO_REQUIRED' }),
      ]),
    });
    expect(h.state().record).toEqual(invalid);
    expect(h.state().car).toEqual(car());
    expect(h.state().events).toEqual([]);
  });

  test.each([
    [record({ status: 'PENDING_APPROVAL' }), car(), 1, 'INSPECTION_LOCKED'],
    [record(), car({ status: CarStatus.AVAILABLE }), 1, 'INVALID_CAR_STATUS'],
    [record(), car({ fuelType: FuelType.GASOLINE }), 1, 'INSPECTION_FORM_TYPE_MISMATCH'],
    [record(), car(), 2, 'FORM_REVISION_CONFLICT'],
  ])('rejects lifecycle, car, template or stale revision mismatch with %s', async (savedRecord, savedCar, baseRevision, code) => {
    const h = harness({ savedRecord, savedCar });

    await expect(h.submit(inspectionId, staffId, baseRevision)).rejects.toMatchObject({ code });
    expect(h.state().events).toEqual([]);
  });

  test('rejects malformed IDs and base revisions before opening a transaction', async () => {
    const h = harness();

    await expect(h.submit('bad-id', staffId, 1)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(h.submit(inspectionId, staffId, 0)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.unitOfWork.run).not.toHaveBeenCalled();
  });

  test('only one of two concurrent submissions succeeds', async () => {
    const h = harness();

    const results = await Promise.allSettled([
      h.submit(inspectionId, staffId, 1), h.submit(inspectionId, staffId, 1),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected').map(({ reason }) => reason.code))
      .toEqual(['INSPECTION_LOCKED']);
    expect(h.state().events).toHaveLength(1);
  });

  test('rolls back the status update when audit persistence fails', async () => {
    const h = harness({ auditFailure: new Error('audit failed') });
    const before = h.state();

    await expect(h.submit(inspectionId, staffId, 1)).rejects.toThrow('audit failed');

    expect(h.state()).toEqual(before);
  });
});
