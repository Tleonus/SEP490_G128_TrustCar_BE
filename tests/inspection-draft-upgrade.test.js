import { expect, test } from '@jest/globals';
import { FuelType, InspectionStatus } from '../src/constants/appConstants.js';
import { getChecklist } from '../src/config/inspectionChecklist.js';
import { CPO_CRITERIA, InspectionResult } from '../src/domain/inspection/criteria.js';
import { collectDefinitionIssues, QuestionType } from '../src/domain/inspection/formDefinition.js';
import {
  createElectricInitialForm, createGasolineInitialForm, legacyQuestionId,
} from '../src/infra/inspection/initialFormDefinitions.js';
import { previewInspectionDraftUpgrade } from '../src/infra/inspection/inspectionDraftUpgrade.js';
import InspectionRecord from '../src/models/InspectionRecord.js';

const carId = '000000000000000000000001';
const inspectionId = '000000000000000000000002';
const otherRecordId = '000000000000000000000003';
const updatedAt = new Date('2026-11-23T15:00:00Z');
const bodyQuestionId = legacyQuestionId('G1_BODY_FRAME', 'CHASSIS_RAILS');
const pillarsQuestionId = legacyQuestionId('G1_BODY_FRAME', 'PILLARS');
const photo = 'https://example.test/vehicle.jpg';

function electricFixture() {
  return CPO_CRITERIA.map((criterion) => ({
    ...criterion,
    questions: [{
      id: `fixture-${criterion.key}`, label: 'Câu chấm thử nghiệm', type: QuestionType.SINGLE_CHOICE, required: true,
      config: { options: [{ id: 'fixture-pass', label: 'Đạt', result: InspectionResult.PASS }] },
    }],
  }));
}

function draft(overrides = {}) {
  return {
    _id: inspectionId, carId, status: InspectionStatus.DRAFT, source: 'STAFF',
    checklistVersion: '1.0', updatedAt,
    groups: [{
      groupKey: 'G1_BODY_FRAME', photos: [photo], note: 'Ghi chú cũ',
      items: [{ itemKey: 'CHASSIS_RAILS', result: 'PASS' }, { itemKey: 'PILLARS', result: 'FAIL', note: 'Ghi chú hạng mục' }],
    }],
    ...overrides,
  };
}

function preview({
  records = [draft()],
  cars = [{ _id: carId, fuelType: FuelType.GASOLINE }],
  templates = [createGasolineInitialForm()],
} = {}) {
  return previewInspectionDraftUpgrade({ records, cars, templates });
}

test('gasoline revision one maps every legacy item to a stable, required scoring question', () => {
  const template = createGasolineInitialForm();
  expect(template.templateKey).toBe(FuelType.GASOLINE);
  expect(template.revision).toBe(1);
  expect(collectDefinitionIssues(template)).toEqual([]);
  const allResults = Object.values(InspectionResult);
  for (const [index, { key, label, items }] of getChecklist('1.0').entries()) {
    const group = template.groups[index];
    expect(group).toMatchObject({ key, label });
    expect(group.questions.map(({ id, label: questionLabel }) => [id, questionLabel]))
      .toEqual(items.map((item) => [legacyQuestionId(key, item.key), item.label]));
    expect(group.questions.every((question) => question.required && question.type === QuestionType.SINGLE_CHOICE)).toBe(true);
    for (const { config } of group.questions) {
      expect(config.options.map(({ id, result }) => [id, result])).toEqual(allResults.map((result) => [result, result]));
    }
  }
  template.groups[0].questions[0].config.options[0].label = 'Edited copy';
  expect(createGasolineInitialForm().groups[0].questions[0].config.options[0].label).toBe('Đạt');
});

test('electric revision one requires supplied groups and normalizes a copy', () => {
  expect(() => createElectricInitialForm()).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  const groups = electricFixture();
  groups[0].questions.push({
    id: 'fixture-distance', label: 'Số đo thử nghiệm', type: QuestionType.NUMBER, required: false,
    config: { unit: 'km', min: 0, integer: true, extra: 'unused' },
  });
  const template = createElectricInitialForm(groups);
  expect(template).toMatchObject({ templateKey: FuelType.ELECTRIC, revision: 1 });
  expect(template.groups[0].questions[1].config).toEqual({ min: 0, integer: true, unit: 'km' });
  groups[0].questions[0].config.options[0].label = 'Edited input';
  expect(template.groups[0].questions[0].config.options[0].label).toBe('Đạt');
  groups[0].label = 'Tiêu chí khác';
  expect(() => createElectricInitialForm(groups)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
});

test('preview maps only known unambiguous legacy results and preserves evidence', () => {
  const record = draft();
  record.groups[0].items.push({ itemKey: 'UNKNOWN_ITEM', result: 'PASS' });
  const original = structuredClone(record);
  const report = preview({ records: [record] });
  expect(report.counts).toEqual({ READY: 1, SKIPPED: 0, BLOCKED: 0 });
  expect(report.duplicates).toEqual([]);
  const [plan] = report.results;
  expect(plan).toEqual({
    outcome: 'READY', inspectionId, carId,
    expected: {
      status: InspectionStatus.DRAFT, templateKey: null, checklistVersion: '1.0',
      updatedAt, fuelType: FuelType.GASOLINE, templateRevision: 1,
    },
    changes: {
      templateKey: FuelType.GASOLINE, checklistVersion: '1',
      answers: [{ questionId: bodyQuestionId, value: 'PASS' }, { questionId: pillarsQuestionId, value: 'FAIL' }],
      archivedAnswers: [],
    },
  });
  expect(record).toEqual(original);
  expect(new InspectionRecord({ ...record, ...plan.changes }).validateSync()).toBeUndefined();
});

test('preview archives retired or changed mappings and keeps existing archived and unversioned values', () => {
  const current = createGasolineInitialForm();
  current.revision = 4;
  current.groups[0].questions = current.groups[0].questions.filter(({ id }) => id !== bodyQuestionId);
  current.groups[0].questions.find(({ id }) => id === pillarsQuestionId)
    .config.options.find(({ id }) => id === 'FAIL').result = 'PASS';
  const report = preview({
    records: [draft({
      archivedAnswers: [{ questionId: 'older', value: 'Old', sourceRevision: 2 }],
      answers: [{ questionId: 'unbound', value: 51 }],
    })],
    templates: [current],
  });
  expect(report.results[0]).toMatchObject({
    expected: { templateRevision: 4 },
    changes: {
      checklistVersion: '4', answers: [],
      archivedAnswers: [
        { questionId: 'older', value: 'Old', sourceRevision: 2 },
        { questionId: 'unbound', value: 51, sourceRevision: null },
        { questionId: bodyQuestionId, value: 'PASS', sourceRevision: 1 },
        { questionId: pillarsQuestionId, value: 'FAIL', sourceRevision: 1 },
      ],
    },
  });
});

test('does not choose between duplicate legacy item results', () => {
  const record = draft();
  record.groups[0].items.push({ itemKey: 'CHASSIS_RAILS', result: 'FAIL' });
  const result = preview({ records: [record] }).results[0];
  expect(result.changes.answers).toEqual([{ questionId: pillarsQuestionId, value: 'FAIL' }]);
  expect(record.groups[0].items.filter(({ itemKey }) => itemKey === 'CHASSIS_RAILS')).toHaveLength(2);
});

test('electric migration attaches the supplied form and requires new electric scoring', () => {
  const record = draft({ answers: [{ questionId: 'unbound', value: 'Existing evidence' }] });
  const cars = [{ id: carId, fuelType: FuelType.ELECTRIC }];
  expect(preview({ records: [record], cars }).results[0]).toMatchObject({
    outcome: 'BLOCKED', code: 'INSPECTION_TEMPLATE_NOT_AVAILABLE',
  });
  expect(preview({ records: [record], cars, templates: [createElectricInitialForm(electricFixture())] }).results[0])
    .toMatchObject({
      outcome: 'READY',
      changes: {
        templateKey: FuelType.ELECTRIC, checklistVersion: '1', answers: [],
        archivedAnswers: [{ questionId: 'unbound', value: 'Existing evidence', sourceRevision: null }],
      },
    });
  expect(record.groups[0].items).toHaveLength(2);
});

test.each([
  [{}, [], 'CAR_NOT_FOUND'],
  [{}, [{ _id: carId, fuelType: FuelType.DIESEL }], 'INSPECTION_TEMPLATE_NOT_AVAILABLE'],
  [{}, [{ _id: carId }], 'INSPECTION_TEMPLATE_NOT_AVAILABLE'],
  [{ templateKey: FuelType.ELECTRIC, checklistVersion: '1' }, undefined, 'INSPECTION_FORM_TYPE_MISMATCH'],
  [{ templateKey: FuelType.GASOLINE, checklistVersion: '1.0' }, undefined, 'FORM_REVISION_CONFLICT'],
  [{ checklistVersion: '2.0' }, undefined, 'UNKNOWN_LEGACY_CHECKLIST'],
  [{ updatedAt: undefined }, undefined, 'MISSING_DRAFT_UPDATE_TIME'],
  [{ answers: [{ questionId: 'bad', value: {} }] }, undefined, 'INVALID_LEGACY_ANSWERS'],
  [{ groups: [{ groupKey: 'G1_BODY_FRAME', items: {} }] }, undefined, 'INVALID_LEGACY_GROUPS'],
])('returns a blocker without a patch for invalid source data', (fields, cars, code) => {
  const [result] = preview({ records: [draft(fields)], cars }).results;
  expect(result).toMatchObject({ outcome: 'BLOCKED', code });
  expect(result).not.toHaveProperty('changes');
});

test.each([InspectionStatus.PENDING_APPROVAL, InspectionStatus.SUBMITTED, undefined])(
  'keeps historical and locked records unchanged for status %s', (status) => {
    const record = draft({ status });
    expect(preview({ records: [record] }).results[0]).toMatchObject({ outcome: 'SKIPPED', code: 'NOT_DRAFT' });
  },
);

test('does not plan a second update after a successful upgrade', () => {
  const record = draft();
  const changes = preview({ records: [record] }).results[0].changes;
  expect(preview({ records: [{ ...record, ...changes }] }).results[0]).toMatchObject({
    outcome: 'SKIPPED', code: 'ALREADY_VERSIONED',
  });
});

test('reports duplicate open records across DRAFT and PENDING_APPROVAL', () => {
  const report = preview({ records: [
    draft(), draft({ _id: otherRecordId, status: InspectionStatus.PENDING_APPROVAL }),
  ] });
  expect(report.duplicates).toEqual([{ carId, count: 2 }]);
  expect(report.counts).toEqual({ READY: 0, SKIPPED: 1, BLOCKED: 1 });
  expect(report.results[0]).toMatchObject({ outcome: 'BLOCKED', code: 'OPEN_INSPECTION_DUPLICATE' });
});
