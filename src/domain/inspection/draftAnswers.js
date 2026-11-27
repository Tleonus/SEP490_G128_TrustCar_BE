import { FuelType } from '../../constants/appConstants.js';
import { QuestionType, validateQuestionAnswer } from './formDefinition.js';

const templateKeysByFuel = new Map([
  [FuelType.ELECTRIC, 'ELECTRIC'],
  [FuelType.GASOLINE, 'GASOLINE'],
]);

const formTypeMismatch = 'INSPECTION_FORM_TYPE_MISMATCH';

/**
 * Determine the template key from the stored vehicle fuel type.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-044
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-045
 */
export function selectInspectionTemplate(fuelType, savedTemplateKey = null) {
  const templateKey = templateKeysByFuel.get(fuelType);
  if (!templateKey) return { code: 'INSPECTION_TEMPLATE_NOT_AVAILABLE' };
  if (savedTemplateKey != null && savedTemplateKey !== templateKey) {
    return { code: formTypeMismatch };
  }
  return { templateKey };
}

function indexQuestions(template) {
  return new Map(template.groups.flatMap(({ questions }) =>
    questions.map((question) => [question.id, question])));
}

function optionsFor(question) {
  return question.type === QuestionType.SINGLE_CHOICE ? question.config.options : [];
}

function canKeepAnswer(previousQuestion, currentQuestion, value) {
  if (!previousQuestion || !currentQuestion || previousQuestion.type !== currentQuestion.type) {
    return false;
  }
  if (validateQuestionAnswer(currentQuestion, value)) return false;
  if (currentQuestion.type === QuestionType.NUMBER) {
    return previousQuestion.config.unit === currentQuestion.config.unit;
  }
  if (currentQuestion.type === QuestionType.SINGLE_CHOICE) {
    const priorOption = optionsFor(previousQuestion).find(({ id }) => id === value);
    const currentOption = optionsFor(currentQuestion).find(({ id }) => id === value);
    return Boolean(priorOption && currentOption &&
      (priorOption.result ?? null) === (currentOption.result ?? null));
  }
  return true;
}

/**
 * Project saved answers onto the current version of the same template. A
 * caller can present the projection or persist it alongside the new revision.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-005
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-018
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-043
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-045
 */
export function reconcileDraftAnswers({
  previousTemplate, currentTemplate, answers = [], archivedAnswers = [],
}) {
  if (previousTemplate && previousTemplate.templateKey !== currentTemplate.templateKey) {
    return { code: formTypeMismatch };
  }

  const previousQuestions = previousTemplate ? indexQuestions(previousTemplate) : new Map();
  const currentQuestions = indexQuestions(currentTemplate);
  const kept = [];
  const archive = [...archivedAnswers];
  for (const { questionId, value } of answers) {
    const previousQuestion = previousQuestions.get(questionId);
    const currentQuestion = currentQuestions.get(questionId);
    if (value == null) continue;
    if (canKeepAnswer(previousQuestion, currentQuestion, value)) {
      kept.push({ questionId, value });
    } else {
      archive.push({ questionId, value, sourceRevision: previousTemplate?.revision ?? null });
    }
  }
  return { answers: kept, archivedAnswers: archive };
}

/**
 * Check and merge an answer patch by question ID. A null value clears an
 * answer in a draft. An omitted question retains its saved answer.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-005
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-006
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-009
 */
export function mergeDraftAnswers(template, savedAnswers, updates) {
  const questions = indexQuestions(template);
  const merged = new Map(savedAnswers.map(({ questionId, value }) => [questionId, value]));
  const seen = new Set();
  const issues = [];
  for (const [index, update] of updates.entries()) {
    const questionId = update?.questionId;
    const question = questions.get(questionId);
    const field = `answers.${index}`;
    if (!question || seen.has(questionId)) {
      issues.push({ field: `${field}.questionId`, message: 'ID câu hỏi không hợp lệ hoặc bị trùng.' });
      continue;
    }
    seen.add(questionId);
    const { value } = update;
    const error = value === undefined
      ? 'Thiếu giá trị câu trả lời.'
      : validateQuestionAnswer(question, value);
    if (error) {
      issues.push({ field: `${field}.value`, message: error });
    } else if (value === null) {
      merged.delete(questionId);
    } else {
      merged.set(questionId, value);
    }
  }
  if (issues.length) return { issues };
  return { answers: Array.from(merged, ([questionId, value]) => ({ questionId, value })), issues };
}

/**
 * Carry forward retired IDs when publishing a normalized template definition.
 * Option IDs are scoped to their question.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-043
 */
export function trackTemplateIds(previousTemplate, nextTemplate) {
  const previousQuestions = previousTemplate ? indexQuestions(previousTemplate) : new Map();
  const nextQuestions = indexQuestions(nextTemplate);
  const retiredQuestions = new Set(previousTemplate?.retiredIds?.questions);
  const retiredOptions = new Map();
  for (const { questionId, optionId } of previousTemplate?.retiredIds?.options ?? []) {
    const optionIds = retiredOptions.get(questionId) ?? new Set();
    optionIds.add(optionId);
    retiredOptions.set(questionId, optionIds);
  }

  for (const [questionId, previousQuestion] of previousQuestions) {
    const nextQuestion = nextQuestions.get(questionId);
    if (!nextQuestion) {
      retiredQuestions.add(questionId);
      continue;
    }
    const activeOptions = new Set(optionsFor(nextQuestion).map(({ id }) => id));
    const removedOptions = optionsFor(previousQuestion).filter(({ id }) => !activeOptions.has(id));
    if (removedOptions.length) {
      const optionIds = retiredOptions.get(questionId) ?? new Set();
      for (const { id } of removedOptions) optionIds.add(id);
      retiredOptions.set(questionId, optionIds);
    }
  }

  const issues = [];
  for (const [questionId, question] of nextQuestions) {
    if (retiredQuestions.has(questionId)) {
      issues.push({ questionId, message: 'ID câu hỏi đã ngừng sử dụng.' });
      continue;
    }
    for (const { id } of optionsFor(question)) {
      if (retiredOptions.get(questionId)?.has(id)) {
        issues.push({ questionId, optionId: id, message: 'ID đáp án đã ngừng sử dụng.' });
      }
    }
  }

  return {
    retiredIds: {
      questions: [...retiredQuestions],
      options: Array.from(retiredOptions).flatMap(([questionId, ids]) =>
        Array.from(ids, (optionId) => ({ questionId, optionId }))),
    },
    issues,
  };
}
