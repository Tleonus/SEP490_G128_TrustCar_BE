import { FuelType } from '../../constants/appConstants.js';
import { trackTemplateIds } from '../../domain/inspection/draftAnswers.js';
import { collectDefinitionIssues } from '../../domain/inspection/formDefinition.js';
import { isCriteriaTemplate } from './criteriaInspection.js';

const templateKeys = [FuelType.ELECTRIC, FuelType.GASOLINE];

function validationError(errors) {
  return Object.assign(new Error('Invalid inspection form template.'), { code: 'VALIDATION_ERROR', errors });
}

function templateUnavailable() {
  return Object.assign(new Error('No inspection template is available.'), {
    code: 'INSPECTION_TEMPLATE_NOT_AVAILABLE',
  });
}

function revisionConflict() {
  return Object.assign(new Error('The template revision has changed.'), { code: 'FORM_REVISION_CONFLICT' });
}

function validateTemplateKey(templateKey) {
  if (!templateKeys.includes(templateKey)) {
    throw validationError([{ field: 'templateKey', message: 'Invalid template key.' }]);
  }
}

export function createFormTemplateUseCases({ templates, unitOfWork }) {
  return {
    /** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-040 */
    async getTemplate(templateKey) {
      validateTemplateKey(templateKey);
      const template = await templates.findCurrent(templateKey);
      if (!template) throw templateUnavailable();
      return template;
    },

    /**
     * Publish for an actor authorized by the inspection policy at the interface.
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-041
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-042
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-043
     */
    async updateTemplate(templateKey, actorId, { baseRevision, groups }) {
      validateTemplateKey(templateKey);
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 1 || baseRevision >= Number.MAX_SAFE_INTEGER) {
        throw validationError([{ field: 'baseRevision', message: 'Expected a valid base revision.' }]);
      }

      return unitOfWork.run(async ({ templates: writer }) => {
        const current = await writer.findCurrent(templateKey);
        if (!current) throw templateUnavailable();
        if (isCriteriaTemplate(current)) {
          throw Object.assign(new Error('This template requires the proposal workflow.'), { code: 'FORM_REVISION_CONFLICT' });
        }
        if (current.revision !== baseRevision) throw revisionConflict();

        const next = { templateKey, revision: baseRevision + 1, groups };
        const problems = collectDefinitionIssues(next);
        if (problems.length) throw validationError(problems);
        const { retiredIds, issues } = trackTemplateIds(current, next);
        if (issues.length) {
          throw validationError(issues.map(({ questionId, optionId, message }) => ({
            field: optionId === undefined ? 'groups.questions.id' : 'groups.questions.config.options.id',
            questionId,
            ...(optionId === undefined ? {} : { optionId }),
            message,
          })));
        }

        const saved = await writer.publish({ ...next, retiredIds }, baseRevision, actorId);
        if (!saved) throw revisionConflict();
        return saved;
      });
    },
  };
}
