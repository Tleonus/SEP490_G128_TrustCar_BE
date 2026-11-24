import { describe, expect, test } from '@jest/globals';
import { getChecklist } from '../src/config/inspectionChecklist.js';
import { CPO_CRITERIA, evaluateCpo } from '../src/domain/inspection/criteria.js';
import {
  collectDefinitionIssues, deriveDetailedCriteria, validateQuestionAnswer,
} from '../src/domain/inspection/formDefinition.js';

const scored = (id, required = true) => ({
  id, label: 'Kết quả kiểm tra', required, type: 'SINGLE_CHOICE',
  config: { options: [
    { id: 'pass', label: 'Đạt', result: 'PASS' },
    { id: 'fail', label: 'Không đạt', result: 'FAIL' },
    { id: 'unknown', label: 'Không kiểm tra được', result: 'NOT_CHECKABLE' },
  ] },
});

const form = () => ({
  groups: CPO_CRITERIA.map((criterion) => ({ ...criterion, questions: [scored(criterion.key)] })),
});

const passingAnswers = () => CPO_CRITERIA.map(({ key }) => ({ questionId: key, value: 'pass' }));

describe('CPO form rules (KAN-52)', () => {
  test('keeps the existing keys, order and labels for both form types', () => {
    expect(CPO_CRITERIA).toEqual(getChecklist().map(({ key, label, criteriaKey }) => ({
      key, label, criteriaKey,
    })));
    expect(collectDefinitionIssues(form())).toEqual([]);
  });

  test.each([
    ['changes the key', (groups) => { groups[0].key = 'OTHER'; }],
    ['renames a group', (groups) => { groups[0].label = 'Tên mới'; }],
    ['reorders groups', (groups) => { groups.reverse(); }],
    ['removes a group', (groups) => { groups.pop(); }],
    ['makes a group optional', (groups) => { groups[0].required = false; }],
    ['removes a required scoring question', (groups) => { groups[0].questions[0].required = false; }],
    ['reuses a question ID', (groups) => { groups[0].questions.push(scored(groups[1].key)); }],
    ['duplicates an option ID', (groups) => {
      const { options } = groups[0].questions[0].config;
      options.push({ ...options[0] });
    }],
  ])('rejects a definition that %s', (_name, change) => {
    const definition = form();
    change(definition.groups);
    expect(collectDefinitionIssues(definition)).not.toHaveLength(0);
  });

  test.each([
    [{ type: 'TEXT', config: { maxLength: 5 } }, 'Đạt', 'quá dài'],
    [{ type: 'NUMBER', config: { min: 0, max: 1000, integer: true, unit: 'km' } }, 900, '900'],
    [{ type: 'NUMBER', config: { min: 0, max: 1000, integer: true } }, 0, 0.5],
    [{ type: 'IMAGE', config: { minCount: 1, maxCount: 1 } }, ['https://example.test/car.jpg'], ['http://example.test/car.jpg']],
    [scored('body'), 'pass', 'missing-option'],
  ])('checks the shape and limits of each answer: %j', (question, valid, invalid) => {
    const q = { ...question, required: true };
    expect(validateQuestionAnswer(q, valid)).toBeNull();
    expect(validateQuestionAnswer(q, invalid)).not.toBeNull();
    expect(validateQuestionAnswer(q, undefined)).toBeNull();
    expect(validateQuestionAnswer(q, undefined, { forSubmission: true })).not.toBeNull();
  });

  test('accepts missing optional answers and rejects invalid field configurations', () => {
    expect(validateQuestionAnswer({ type: 'TEXT', required: false, config: { maxLength: 10 } },
      undefined, { forSubmission: true })).toBeNull();
    expect(validateQuestionAnswer({ type: 'NUMBER', config: { min: 20, max: 10 } }, 15)).not.toBeNull();
    expect(validateQuestionAnswer({ type: 'IMAGE', required: true, config: { minCount: 0, maxCount: 2 } },
      [], { forSubmission: true })).not.toBeNull();
  });

  test('requires five true flags for both detailed approval and quick inspection', () => {
    const flags = deriveDetailedCriteria(form(), passingAnswers());
    expect(evaluateCpo(flags)).toBe(true);
    expect(evaluateCpo({ ...flags, verifiedOdo: 1 })).toBe(false);
    const { verifiedOdo: _removed, ...incomplete } = flags;
    expect(evaluateCpo(incomplete)).toBe(false);
  });

  test.each(['fail', 'unknown', undefined])('fails a criterion when a required score is %s', (value) => {
    const answers = passingAnswers();
    answers[0].value = value;
    const flags = deriveDetailedCriteria(form(), answers);
    expect(flags.noMajorAccident).toBe(false);
    expect(evaluateCpo(flags)).toBe(false);
  });

  test('fails closed if scoring answers have duplicate IDs', () => {
    const answers = passingAnswers();
    expect(evaluateCpo(deriveDetailedCriteria(form(), [...answers, answers[0]]))).toBe(false);
  });
});
