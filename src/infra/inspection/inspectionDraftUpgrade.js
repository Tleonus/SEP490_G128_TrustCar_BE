import { FuelType, InspectionStatus } from '../../constants/appConstants.js';
import { InspectionResult } from '../../domain/inspection/criteria.js';
import { reconcileDraftAnswers, selectInspectionTemplate } from '../../domain/inspection/draftAnswers.js';
import { collectDefinitionIssues } from '../../domain/inspection/formDefinition.js';
import { createGasolineInitialForm, legacyQuestionId, LEGACY_CHECKLIST_VERSION } from './initialFormDefinitions.js';

const openStatuses = new Set([InspectionStatus.DRAFT, InspectionStatus.PENDING_APPROVAL]);
const legacyResults = new Set(Object.values(InspectionResult));
const documentId = (record) => String(record?._id ?? record?.id ?? '');
const validRevision = (revision) => Number.isSafeInteger(revision) && revision > 0;
const validId = (id) => /^[a-f0-9]{24}$/i.test(id);

const validAnswer = (answer) => typeof answer?.questionId === 'string' && answer.questionId.trim() !== '' && (
  typeof answer.value === 'string' || Number.isFinite(answer.value) ||
  (Array.isArray(answer.value) && answer.value.every((item) => typeof item === 'string'))
);

function archiveUnversionedAnswers(record) {
  const existing = record.archivedAnswers ?? [];
  const unversioned = record.answers ?? [];
  if (!Array.isArray(existing) || !Array.isArray(unversioned) || !existing.every((answer) =>
    validAnswer(answer) && (answer.sourceRevision == null || validRevision(answer.sourceRevision))
  ) || !unversioned.every(validAnswer)) return null;

  return [
    ...structuredClone(existing),
    ...unversioned.map(({ questionId, value }) => ({ questionId, value: structuredClone(value), sourceRevision: null })),
  ];
}

function legacyGasolineAnswers(record, previousTemplate) {
  const matches = new Map();
  const repeated = new Set();
  for (const group of record.groups ?? []) {
    for (const item of group?.items ?? []) {
      const id = legacyQuestionId(group?.groupKey, item?.itemKey);
      if (matches.has(id)) repeated.add(id);
      matches.set(id, item?.result);
    }
  }
  return previousTemplate.groups.flatMap(({ questions }) => questions.flatMap(({ id }) => {
    const value = matches.get(id);
    return repeated.has(id) || !legacyResults.has(value) ? [] : [{ questionId: id, value }];
  }));
}

function draftChanges(record, template, previousTemplate) {
  const archivedAnswers = archiveUnversionedAnswers(record);
  if (!archivedAnswers) return null;
  if (template.templateKey !== FuelType.GASOLINE) return { answers: [], archivedAnswers };

  const answers = legacyGasolineAnswers(record, previousTemplate);
  return reconcileDraftAnswers({ previousTemplate, currentTemplate: template, answers, archivedAnswers });
}

function templateIndex(templates) {
  const byKey = new Map();
  for (const template of templates) {
    const key = template?.templateKey;
    const usable = validRevision(template?.revision) && collectDefinitionIssues(template).length === 0;
    byKey.set(key, usable && !byKey.has(key) ? template : null);
  }
  return byKey;
}

function findDuplicateOpenCars(records) {
  const counts = new Map();
  for (const { status, carId } of records) {
    if (!openStatuses.has(status) || carId == null) continue;
    const key = String(carId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([carId, count]) => ({ carId, count }));
}

function previewRecord(record, cars, forms, duplicateCars, gasolineBaseline) {
  const inspectionId = documentId(record);
  const carId = String(record.carId ?? '');
  const row = { inspectionId, carId };
  const skip = (code) => ({ ...row, outcome: 'SKIPPED', code });
  const block = (code) => ({ ...row, outcome: 'BLOCKED', code });
  if (record.status !== InspectionStatus.DRAFT) return skip('NOT_DRAFT');
  if (!validId(inspectionId) || !validId(carId)) return block('INVALID_RECORD_ID');
  if (duplicateCars.has(carId)) return block('OPEN_INSPECTION_DUPLICATE');
  const car = cars.get(carId);
  if (!car) return block('CAR_NOT_FOUND');
  const selected = selectInspectionTemplate(car.fuelType, record.templateKey);
  if (selected.code) return block(selected.code);
  if (record.templateKey != null) {
    const version = String(record.checklistVersion ?? '');
    return /^[1-9]\d*$/.test(version) && validRevision(Number(version))
      ? skip('ALREADY_VERSIONED')
      : block('FORM_REVISION_CONFLICT');
  }
  if (record.checklistVersion !== LEGACY_CHECKLIST_VERSION) {
    return block('UNKNOWN_LEGACY_CHECKLIST');
  }
  if (!(record.updatedAt instanceof Date) || !Number.isFinite(record.updatedAt.getTime())) {
    return block('MISSING_DRAFT_UPDATE_TIME');
  }
  const template = forms.get(selected.templateKey);
  if (!template) return block('INSPECTION_TEMPLATE_NOT_AVAILABLE');
  const groups = record.groups ?? [];
  if (!Array.isArray(groups) || groups.some((group) => group?.items != null && !Array.isArray(group.items))) {
    return block('INVALID_LEGACY_GROUPS');
  }
  const projected = draftChanges(record, template, gasolineBaseline);
  if (!projected) return block('INVALID_LEGACY_ANSWERS');

  return {
    ...row,
    outcome: 'READY',
    expected: {
      status: InspectionStatus.DRAFT, templateKey: null, checklistVersion: record.checklistVersion,
      updatedAt: new Date(record.updatedAt.getTime()), fuelType: car.fuelType, templateRevision: template.revision,
    },
    changes: { templateKey: template.templateKey, checklistVersion: String(template.revision), ...projected },
  };
}

/**
 * Read-only plan over exported records, car identities/fuel types and current forms.
 * Include all open records in the input to detect cross-status duplicates.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-005
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-018
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-044
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-045
 */
export function previewInspectionDraftUpgrade({ records, cars, templates }) {
  const duplicates = findDuplicateOpenCars(records);
  const duplicateCars = new Set(duplicates.map(({ carId }) => carId));
  const carsById = new Map(cars.map((car) => [documentId(car), car]));
  const forms = templateIndex(templates);
  const gasolineBaseline = createGasolineInitialForm();
  const results = records.map((record) => previewRecord(record, carsById, forms, duplicateCars, gasolineBaseline));
  const counts = { READY: 0, SKIPPED: 0, BLOCKED: 0 };
  for (const { outcome } of results) counts[outcome] += 1;
  return { counts, duplicates, results };
}
