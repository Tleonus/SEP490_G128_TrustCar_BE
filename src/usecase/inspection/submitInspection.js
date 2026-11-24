import { ActivityEventType, CarStatus, InspectionStatus } from '../../constants/appConstants.js';
import { getChecklist, INSPECTION_LIMITS } from '../../config/inspectionChecklist.js';
import { InspectionResult } from '../../domain/inspection/criteria.js';
import { reconcileDraftAnswers, selectInspectionTemplate } from '../../domain/inspection/draftAnswers.js';
import { collectDefinitionIssues, QuestionType, validateQuestionAnswer } from '../../domain/inspection/formDefinition.js';
import { collectSubmitViolations } from '../../services/inspectionSubmitRules.js';

export const pendingApprovalStatus = 'PENDING_APPROVAL';
const evidenceChecklist = getChecklist().map((group) => ({ ...group, items: [] }));
const confirmedTextFields = ['make', 'model', 'variant', 'color'];

function submitError(code, message, errors) {
  return Object.assign(new Error(message), { code, ...(errors ? { errors } : {}) });
}

function locked() {
  return submitError('INSPECTION_LOCKED', 'This inspection is locked.');
}

function revisionConflict() {
  return submitError('FORM_REVISION_CONFLICT', 'The template revision has changed.');
}

function checkConfirmedValues(confirmed = {}, now) {
  const issues = [];
  for (const field of confirmedTextFields) {
    const value = confirmed[field];
    if (value != null && (typeof value !== 'string' || value.trim().length > INSPECTION_LIMITS.VEHICLE_TEXT_MAX_LENGTH)) {
      issues.push({ field: `vehicleInfo.confirmed.${field}`, code: 'INVALID_VEHICLE_INFO', message: 'Invalid vehicle information.' });
    }
  }
  const { year, mileage } = confirmed;
  if (year != null && (!Number.isSafeInteger(year) || year < INSPECTION_LIMITS.MIN_YEAR || year > now.getFullYear() + 1)) {
    issues.push({ field: 'vehicleInfo.confirmed.year', code: 'INVALID_VEHICLE_INFO', message: 'Invalid production year.' });
  }
  if (mileage != null && (!Number.isSafeInteger(mileage) || mileage < 0)) {
    issues.push({ field: 'vehicleInfo.confirmed.mileage', code: 'INVALID_VEHICLE_INFO', message: 'Invalid mileage.' });
  }
  return issues;
}

function checkFormAnswers(record, form, isValidImageUrl) {
  const issues = [];
  const dynamicEvidencePaths = new Set();
  const questions = new Set(form.groups.flatMap(({ questions: fields }) => fields.map(({ id }) => id)));
  const answers = new Map();
  for (const [index, answer] of (record.answers ?? []).entries()) {
    const { questionId, value } = answer ?? {};
    if (!questions.has(questionId) || answers.has(questionId)) {
      issues.push({
        field: `answers.${index}.questionId`, code: 'INVALID_QUESTION_ID', message: 'Unknown or duplicate question ID.',
      });
      continue;
    }
    answers.set(questionId, { value, field: `answers.${index}.value` });
  }

  const evidence = new Map((record.groups ?? []).map((group, index) =>
    [group.groupKey, { group, field: `groups.${index}` }]));
  for (const { key, questions: fields } of form.groups) {
    const { group, field } = evidence.get(key) ?? { field: `groups.${key}` };
    const outcomes = [];
    let hasFormImage = false;
    for (const question of fields) {
      const { value, field: path } = answers.get(question.id) ?? { field: `answers.${question.id}` };
      const message = validateQuestionAnswer(question, value, { forSubmission: true });
      if (message) {
        issues.push({
          field: path, questionId: question.id, code: value == null ? 'REQUIRED' : 'INVALID_ANSWER', message,
        });
      }
      if (question.type === QuestionType.IMAGE && Array.isArray(value)) {
        for (const [index, url] of value.entries()) {
          if (isValidImageUrl(url)) {
            if (!message) hasFormImage = true;
          } else {
            issues.push({
              field: `${path}.${index}`, code: 'INVALID_IMAGE_URL', message: 'Image must be uploaded to this inspection folder.',
            });
          }
        }
      }
      if (question.type === QuestionType.SINGLE_CHOICE) {
        const result = question.config.options.find(({ id }) => id === value)?.result;
        if (result === InspectionResult.FAIL || result === InspectionResult.NOT_CHECKABLE) {
          outcomes.push({ questionId: question.id, result });
        }
      }
    }
    if (hasFormImage && group) dynamicEvidencePaths.add(`${field}.photos`);
    if (!outcomes.length) continue;

    const hasNote = typeof group?.note === 'string' && group.note.trim() !== '';
    const hasPhoto = hasFormImage || [
      ...(group?.photos ?? []), group?.odometerPhoto, ...(group?.items ?? []).flatMap(({ photos }) => photos ?? []),
    ].some(isValidImageUrl);
    for (const { questionId, result } of outcomes) {
      if (!hasNote) {
        const failed = result === InspectionResult.FAIL;
        issues.push({
          field: `${field}.note`, questionId, code: failed ? 'FAIL_NOTE_REQUIRED' : 'REASON_REQUIRED',
          message: failed ? 'A failed answer needs a technical note.' : 'An unchecked answer needs a reason.',
        });
      }
      if (result === InspectionResult.FAIL && !hasPhoto) {
        issues.push({
          field: `${field}.photos`, questionId, code: 'FAIL_PHOTO_REQUIRED', message: 'A failed answer needs an evidence photo.',
        });
      }
    }
  }
  return { issues, dynamicEvidencePaths };
}

function checkSubmission(record, car, template, isValidImageUrl, now) {
  const systemIssues = collectSubmitViolations({
    record, carMileage: car.mileage, checklist: evidenceChecklist, isValidImageUrl,
  });
  const confirmedIssues = checkConfirmedValues(record.vehicleInfo?.confirmed, now);
  const definitionIssues = collectDefinitionIssues(template);
  if (definitionIssues.length) {
    return [...systemIssues, ...confirmedIssues, ...definitionIssues.map(({ field, message }) => ({
      field: `template.${field}`, code: 'INVALID_TEMPLATE', message,
    }))];
  }

  const { issues, dynamicEvidencePaths } = checkFormAnswers(record, template, isValidImageUrl);
  const requiredEvidence = systemIssues.filter(({ code, field }) =>
    code !== 'GROUP_PHOTO_REQUIRED' || !dynamicEvidencePaths.has(field));
  return [...requiredEvidence, ...confirmedIssues, ...issues];
}

async function answersForSubmission(record, template, templates) {
  if (record.templateRevision === template.revision) {
    return { answers: record.answers ?? [], archivedAnswers: record.archivedAnswers ?? [] };
  }
  const previousTemplate = await templates.findRevision(record.templateKey, record.templateRevision);
  if (!previousTemplate) throw revisionConflict();
  const projected = reconcileDraftAnswers({
    previousTemplate, currentTemplate: template, answers: record.answers ?? [], archivedAnswers: record.archivedAnswers ?? [],
  });
  if (projected.code) throw submitError(projected.code, 'The saved inspection uses a different template.');
  return projected;
}

export function createSubmitInspection({ unitOfWork, isInspectionImageUrl, now = () => new Date() }) {
  /**
   * Submit the saved answers for approval; only the revision comes from the request.
   * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-007
   * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-012
   * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-013
   * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-014
   * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-015
   * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-017
   * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-028
   * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-046
   */
  return async function submitInspection(inspectionId, actorId, baseRevision) {
    if (typeof inspectionId !== 'string' || !/^[a-f\d]{24}$/i.test(inspectionId)) {
      throw submitError('VALIDATION_ERROR', 'Invalid inspection ID.', [{ field: 'id', message: 'Expected an ObjectId.' }]);
    }
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 1) {
      throw submitError('VALIDATION_ERROR', 'Invalid base revision.', [
        { field: 'baseRevision', message: 'Expected a positive base revision.' },
      ]);
    }

    return unitOfWork.run(async ({ cars, records, templates, audit }) => {
      const record = await records.findById(inspectionId);
      if (!record) throw submitError('INSPECTION_NOT_FOUND', 'Inspection not found.');
      if (record.status !== InspectionStatus.DRAFT) throw locked();

      const car = await cars.findById(record.carId);
      if (!car) throw submitError('CAR_NOT_FOUND', 'Car not found.');
      if (car.status !== CarStatus.UNDER_INSPECTION) {
        throw submitError('INVALID_CAR_STATUS', 'Car is no longer under inspection.');
      }
      const selection = selectInspectionTemplate(car.fuelType, record.templateKey);
      if (selection.code) throw submitError(selection.code, 'The car does not match the saved inspection template.');
      const template = record.templateKey != null ? await templates.findCurrent(selection.templateKey) : null;
      if (!template) throw submitError('INSPECTION_TEMPLATE_NOT_AVAILABLE', 'No inspection template is available.');
      if (template.revision !== baseRevision) throw revisionConflict();

      const submittedAt = now();
      const isValidImageUrl = (url) => typeof url === 'string' && isInspectionImageUrl?.(url, inspectionId) === true;
      const projected = await answersForSubmission(record, template, templates);
      const violations = checkSubmission({ ...record, ...projected }, car, template, isValidImageUrl, submittedAt);
      if (violations.length) throw submitError('INSPECTION_INCOMPLETE', 'The inspection is incomplete.', violations);

      const updated = await records.updateIfCurrent(inspectionId, { status: InspectionStatus.DRAFT }, {
        status: pendingApprovalStatus,
        templateRevision: template.revision,
        templateSnapshot: template,
        ...projected,
        inspectorId: actorId, submittedBy: actorId, submittedAt, updatedBy: actorId,
      });
      if (!updated) throw locked();
      await audit.append({
        eventType: ActivityEventType.INSPECTION_SUBMITTED, performedBy: actorId,
        targetModel: 'InspectionRecord', targetId: inspectionId, summary: 'Inspection submitted for approval',
        metadata: {
          carId: record.carId, fromStatus: InspectionStatus.DRAFT, toStatus: pendingApprovalStatus,
          templateRevision: template.revision,
        },
      });
      return updated;
    });
  };
}
