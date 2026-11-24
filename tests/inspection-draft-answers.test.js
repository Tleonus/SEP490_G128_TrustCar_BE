import { describe, expect, test } from '@jest/globals';
import { FuelType } from '../src/constants/appConstants.js';
import {
  mergeDraftAnswers, reconcileDraftAnswers, selectInspectionTemplate, trackTemplateIds,
} from '../src/domain/inspection/draftAnswers.js';

const textQuestion = (id, maxLength = 40) => ({
  id, label: 'Note', required: true, type: 'TEXT', config: { maxLength },
});
const numberQuestion = (id, unit, max = 500_000) => ({
  id, label: 'Reading', required: true, type: 'NUMBER', config: { min: 0, max, integer: true, unit },
});
const choiceQuestion = (id, options) => ({
  id, label: 'Condition', required: true, type: 'SINGLE_CHOICE', config: { options },
});
const option = (id, result) => ({ id, label: id, result });
const form = (revision, questions, templateKey = 'GASOLINE') => ({
  templateKey, revision, groups: [{ key: 'G1_BODY_FRAME', questions }],
});
const answer = (questionId, value) => ({ questionId, value });

describe('Inspection template selection', () => {
  test.each([FuelType.ELECTRIC, FuelType.GASOLINE])('selects the template for %s', (fuelType) => {
    expect(selectInspectionTemplate(fuelType)).toEqual({ templateKey: fuelType });
    expect(selectInspectionTemplate(fuelType, fuelType)).toEqual({ templateKey: fuelType });
  });

  test.each([FuelType.DIESEL, FuelType.HYBRID, FuelType.LPG, null])('has no template for %s', (fuelType) => {
    expect(selectInspectionTemplate(fuelType)).toEqual({ code: 'INSPECTION_TEMPLATE_NOT_AVAILABLE' });
  });

  test('blocks reuse of a gasoline draft after the vehicle is changed to electric', () => {
    expect(selectInspectionTemplate(FuelType.ELECTRIC, 'GASOLINE'))
      .toEqual({ code: 'INSPECTION_FORM_TYPE_MISMATCH' });
    expect(reconcileDraftAnswers({
      previousTemplate: form(1, [textQuestion('memo')]),
      currentTemplate: form(1, [textQuestion('memo')], 'ELECTRIC'),
      answers: [answer('memo', 'only valid for gasoline')],
    })).toEqual({ code: 'INSPECTION_FORM_TYPE_MISMATCH' });
  });
});

describe('Draft answers across template versions', () => {
  test('keeps compatible values and archives removed, changed-type and out-of-range answers', () => {
    const previousTemplate = form(2, [
      textQuestion('keep'), textQuestion('removed'), textQuestion('changed'), numberQuestion('range', 'km'),
    ]);
    const currentTemplate = form(3, [
      numberQuestion('range', 'km', 500), { ...textQuestion('keep'), label: 'New label' },
      numberQuestion('changed', 'km'), textQuestion('new-required'),
    ]);
    const answers = [
      answer('keep', 'text'), answer('removed', 'old note'), answer('changed', '123'), answer('range', 700),
    ];
    const archivedAnswers = [{ ...answer('earlier', 'kept in history'), sourceRevision: 1 }];

    const result = reconcileDraftAnswers({ previousTemplate, currentTemplate, answers, archivedAnswers });

    expect(result).toEqual({
      answers: [answers[0]],
      archivedAnswers: [...archivedAnswers, ...answers.slice(1).map((item) => ({ ...item, sourceRevision: 2 }))],
    });
    expect(answers).toHaveLength(4);
    expect(archivedAnswers).toHaveLength(1);
    expect(reconcileDraftAnswers({
      previousTemplate: currentTemplate, currentTemplate, ...result,
    })).toEqual(result);
  });

  test('keeps a stable selected option after relabeling and archives a removed or rescored option', () => {
    const previousTemplate = form(1, [
      choiceQuestion('keep', [option('pass', 'PASS')]),
      choiceQuestion('removed', [option('old', 'PASS')]),
      choiceQuestion('rescored', [option('pass', 'PASS')]),
    ]);
    const currentTemplate = form(2, [
      choiceQuestion('keep', [{ ...option('pass', 'PASS'), label: 'Đạt' }]),
      choiceQuestion('removed', [option('new', 'PASS')]),
      choiceQuestion('rescored', [option('pass', 'FAIL')]),
    ]);
    const answers = [answer('keep', 'pass'), answer('removed', 'old'), answer('rescored', 'pass')];

    expect(reconcileDraftAnswers({ previousTemplate, currentTemplate, answers })).toEqual({
      answers: [answers[0]],
      archivedAnswers: answers.slice(1).map((item) => ({ ...item, sourceRevision: 1 })),
    });
  });

  test('archives a number when its unit changes and preserves unversioned answers for review', () => {
    const previousTemplate = form(3, [numberQuestion('distance', 'mi')]);
    const currentTemplate = form(4, [numberQuestion('distance', 'km')]);
    const answers = [answer('distance', 100)];

    expect(reconcileDraftAnswers({ previousTemplate, currentTemplate, answers })).toEqual({
      answers: [], archivedAnswers: [{ ...answers[0], sourceRevision: 3 }],
    });
    expect(reconcileDraftAnswers({ currentTemplate, answers })).toEqual({
      answers: [], archivedAnswers: [{ ...answers[0], sourceRevision: null }],
    });
  });
});

describe('Draft answer patch', () => {
  const template = form(1, [textQuestion('keep'), numberQuestion('distance', 'km'), textQuestion('clear')]);

  test('updates supplied IDs, retains an omitted answer and allows a draft answer to be cleared', () => {
    const saved = [answer('keep', 'stay'), answer('distance', 100), answer('clear', 'old')];
    expect(mergeDraftAnswers(template, saved, [answer('distance', 120), answer('clear', null)]))
      .toEqual({ answers: [saved[0], answer('distance', 120)], issues: [] });
    expect(saved[2].value).toBe('old');
  });

  test('rejects unknown and duplicate IDs, wrong types and omitted values without a partial merge', () => {
    const saved = [answer('keep', 'stay')];
    const result = mergeDraftAnswers(template, saved, [
      answer('keep', 'replace'), answer('missing', 'text'), answer('distance', '123'),
      answer('keep', 'duplicate'), { questionId: 'clear' },
    ]);
    expect(result.issues.map(({ field }) => field)).toEqual([
      'answers.1.questionId', 'answers.2.value', 'answers.3.questionId', 'answers.4.value',
    ]);
    expect(result).not.toHaveProperty('answers');
    expect(saved).toEqual([answer('keep', 'stay')]);
  });
});

describe('Retired template IDs', () => {
  test('carries the removal history forward and rejects reuse within the same question', () => {
    const previous = form(1, [
      textQuestion('deleted'), choiceQuestion('existing', [option('gone'), option('keep')]),
    ]);
    const next = form(2, [choiceQuestion('existing', [option('keep')])]);
    const result = trackTemplateIds(previous, next);
    expect(result).toEqual({
      retiredIds: { questions: ['deleted'], options: [{ questionId: 'existing', optionId: 'gone' }] },
      issues: [],
    });

    const newer = form(3, [
      textQuestion('deleted'), choiceQuestion('existing', [option('gone'), option('keep')]),
      choiceQuestion('other', [option('gone')]),
    ]);
    const reuse = trackTemplateIds({ ...next, retiredIds: result.retiredIds }, newer);
    expect(reuse.retiredIds).toEqual(result.retiredIds);
    expect(reuse.issues.map(({ questionId, optionId }) => [questionId, optionId])).toEqual([
      ['deleted', undefined], ['existing', 'gone'],
    ]);
  });

  test('preserves the retirement of options when a question changes type', () => {
    const previous = form(1, [choiceQuestion('state', [option('old')])]);
    const next = form(2, [textQuestion('state')]);
    const { retiredIds } = trackTemplateIds(previous, next);
    const newer = form(3, [choiceQuestion('state', [option('old'), option('new')])]);
    expect(trackTemplateIds({ ...next, retiredIds }, newer).issues).toEqual([
      expect.objectContaining({ questionId: 'state', optionId: 'old' }),
    ]);
  });
});
