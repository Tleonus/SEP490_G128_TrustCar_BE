import { FuelType } from '../../constants/appConstants.js';
import { getChecklist } from '../../config/inspectionChecklist.js';
import { CPO_CRITERIA, InspectionResult } from '../../domain/inspection/criteria.js';
import { collectDefinitionIssues, QuestionType } from '../../domain/inspection/formDefinition.js';

const optionLabels = {
  [InspectionResult.PASS]: 'Đạt',
  [InspectionResult.FAIL]: 'Không đạt',
  [InspectionResult.NOT_CHECKABLE]: 'Không kiểm tra được',
};

const configFields = {
  [QuestionType.TEXT]: ['maxLength'],
  [QuestionType.NUMBER]: ['min', 'max', 'integer', 'unit'],
  [QuestionType.IMAGE]: ['minCount', 'maxCount'],
};

export const LEGACY_CHECKLIST_VERSION = '1.0';

function normalizeQuestion({ id, label, required, type, config }) {
  if (type === QuestionType.SINGLE_CHOICE) {
    const options = config.options.map(({ id: optionId, label: optionLabel, result }) => ({
      id: optionId, label: optionLabel, ...(result == null ? {} : { result }),
    }));
    return { id, label, required, type, config: { options } };
  }
  const allowed = configFields[type];
  const normalized = Object.fromEntries(allowed.filter((field) => Object.hasOwn(config, field))
    .map((field) => [field, config[field]]));
  return { id, label, required, type, config: normalized };
}

function initialForm(templateKey, groups) {
  const issues = collectDefinitionIssues({ groups });
  if (issues.length) {
    throw Object.assign(new Error('Invalid initial inspection form.'), { code: 'VALIDATION_ERROR', errors: issues });
  }
  return {
    templateKey,
    revision: 1,
    groups: CPO_CRITERIA.map((criterion, index) => ({
      ...criterion, questions: groups[index].questions.map(normalizeQuestion),
    })),
    retiredIds: { questions: [], options: [] },
  };
}

export const legacyQuestionId = (groupKey, itemKey) => `${groupKey}.${itemKey}`;

/**
 * Keep the IDs and scoring semantics deterministic so legacy answers can be projected.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-040
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-043
 */
export function createGasolineInitialForm() {
  const groups = getChecklist(LEGACY_CHECKLIST_VERSION).map(({ items, ...group }) => ({
    ...group,
    questions: items.map(({ key: itemKey, label }) => ({
      id: legacyQuestionId(group.key, itemKey),
      label,
      type: QuestionType.SINGLE_CHOICE,
      required: true,
      config: { options: Object.entries(optionLabels).map(([result, optionLabel]) => ({
        id: result, label: optionLabel, result,
      })) },
    })),
  }));
  return initialForm(FuelType.GASOLINE, groups);
}

/**
 * The rollout operator supplies the groups from the approved electric form.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-040
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-044
 */
export function createElectricInitialForm(groups) {
  return initialForm(FuelType.ELECTRIC, groups);
}
