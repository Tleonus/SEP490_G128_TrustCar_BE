import { CPO_CRITERIA, InspectionResult } from './criteria.js';

export const QuestionType = Object.freeze({
  TEXT: 'TEXT',
  NUMBER: 'NUMBER',
  IMAGE: 'IMAGE',
  SINGLE_CHOICE: 'SINGLE_CHOICE',
});

const validResults = new Set(Object.values(InspectionResult));
const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isMissing = (value) => value == null;

const matchesCriterion = (group, criterion) => (
  group?.key === criterion.key && group.label === criterion.label &&
  (group.required === undefined || group.required === true) &&
  (!Object.hasOwn(group, 'criteriaKey') || group.criteriaKey === criterion.criteriaKey)
);

const isScoring = (question) => (
  question?.type === QuestionType.SINGLE_CHOICE &&
  Array.isArray(question.config?.options) &&
  question.config.options.some((option) => option?.result != null)
);

function validOptions(options) {
  if (!Array.isArray(options) || options.length === 0) return false;
  const seen = new Set();
  const scored = options.some((option) => option?.result != null);
  for (const option of options) {
    if (!isText(option?.id) || !isText(option.label) || seen.has(option.id)) return false;
    if (scored && !validResults.has(option.result)) return false;
    seen.add(option.id);
  }
  return true;
}

const validConfig = {
  [QuestionType.TEXT]: ({ maxLength }) => isCount(maxLength) && maxLength > 0,
  [QuestionType.NUMBER]: ({ min, max, integer, unit }) => (
    (min === undefined || Number.isFinite(min)) && (max === undefined || Number.isFinite(max)) &&
    (min === undefined || max === undefined || min <= max) &&
    (integer === undefined || typeof integer === 'boolean') && (unit === undefined || isText(unit))
  ),
  [QuestionType.IMAGE]: ({ minCount, maxCount }) => (
    isCount(minCount) && isCount(maxCount) && maxCount > 0 && minCount <= maxCount
  ),
  [QuestionType.SINGLE_CHOICE]: ({ options }) => validOptions(options),
};

function addQuestionErrors(issues, questions, path, seenIds) {
  let hasRequiredScore = false;
  for (const [index, question] of questions.entries()) {
    const field = `${path}.questions.${index}`;
    if (!isObject(question) || !isText(question.id) || !isText(question.label) ||
        typeof question.required !== 'boolean' || typeof question.type !== 'string' ||
        !Object.hasOwn(validConfig, question.type)) {
      issues.push({ field, message: 'Thông tin câu hỏi không hợp lệ.' });
      continue;
    }
    if (seenIds.has(question.id)) {
      issues.push({ field: `${field}.id`, message: 'ID câu hỏi bị trùng.' });
    }
    seenIds.add(question.id);
    if (!isObject(question.config) || !validConfig[question.type](question.config)) {
      issues.push({ field: `${field}.config`, message: 'Cấu hình không phù hợp với kiểu câu hỏi.' });
      continue;
    }
    if (question.required && isScoring(question)) hasRequiredScore = true;
  }
  if (!hasRequiredScore) {
    issues.push({ field: `${path}.questions`, message: 'Tiêu chí cần ít nhất một câu chấm bắt buộc.' });
  }
}

/**
 * Validate a normalized form definition before publication.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-041
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-043
 */
export function collectDefinitionIssues(form) {
  if (!Array.isArray(form?.groups) || form.groups.length !== CPO_CRITERIA.length) {
    return [{ field: 'groups', message: 'Biểu mẫu phải có đủ năm tiêu chí cố định.' }];
  }
  const issues = [];
  const seenIds = new Set();
  for (const [index, criterion] of CPO_CRITERIA.entries()) {
    const group = form.groups[index];
    const path = `groups.${index}`;
    if (!matchesCriterion(group, criterion) || !Array.isArray(group.questions)) {
      issues.push({ field: path, message: 'Khóa, nhãn và thứ tự tiêu chí phải giữ nguyên.' });
      continue;
    }
    addQuestionErrors(issues, group.questions, path, seenIds);
  }
  return issues;
}

function isHttpsUrl(value) {
  if (!isText(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

const answerMatches = {
  [QuestionType.TEXT]: (value, config) => isText(value) && value.length <= config.maxLength,
  [QuestionType.NUMBER]: (value, { min, max, integer }) => (
    Number.isFinite(value) && (!integer || Number.isInteger(value)) &&
    (min === undefined || value >= min) && (max === undefined || value <= max)
  ),
  [QuestionType.IMAGE]: (value, { minCount, maxCount }, required) => (
    Array.isArray(value) && value.length >= Math.max(minCount, required ? 1 : 0) &&
    value.length <= maxCount && Array.from(value).every(isHttpsUrl)
  ),
  [QuestionType.SINGLE_CHOICE]: (value, { options }) => options.some(({ id }) => id === value),
};

/**
 * Validate one answer against a published question. The media adapter checks the
 * specific Cloudinary origin and folder; domain validation checks the URL shape.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-013
 */
export function validateQuestionAnswer(question, value, { forSubmission = false } = {}) {
  if (typeof question?.type !== 'string' || !Object.hasOwn(answerMatches, question.type) ||
      !isObject(question.config) ||
      !validConfig[question.type](question.config)) return 'Cấu hình câu hỏi không hợp lệ.';
  if (isMissing(value)) {
    return forSubmission && question.required ? 'Thiếu câu trả lời bắt buộc.' : null;
  }
  return answerMatches[question.type](value, question.config, question.required)
    ? null
    : 'Câu trả lời không phù hợp với cấu hình.';
}

function passesGroup(group, answers) {
  const questions = group.questions.filter(isScoring);
  if (!questions.some((question) => question.required)) return false;
  return questions.every((question) => {
    const value = answers.get(question.id);
    if (!question.required && isMissing(value)) return true;
    return question.config.options.find((option) => option?.id === value)?.result === InspectionResult.PASS;
  });
}

/**
 * Derive the five flags from the saved template and answers.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-026
 */
export function deriveDetailedCriteria(form, answers = []) {
  const allFailed = CPO_CRITERIA.map(({ criteriaKey }) => [criteriaKey, false]);
  if (!Array.isArray(answers) || collectDefinitionIssues(form).length > 0) {
    return Object.fromEntries(allFailed);
  }
  const byId = new Map();
  for (const answer of answers) {
    if (!isText(answer?.questionId) || byId.has(answer.questionId)) return Object.fromEntries(allFailed);
    byId.set(answer.questionId, answer.value);
  }
  return Object.fromEntries(CPO_CRITERIA.map(({ criteriaKey }, index) => [
    criteriaKey, passesGroup(form.groups[index], byId),
  ]));
}
