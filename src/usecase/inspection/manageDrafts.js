import {
  ActivityEventType, CarStatus, InspectionSource, InspectionStatus,
} from '../../constants/appConstants.js';
import { findGroup, INSPECTION_LIMITS, OVERVIEW_POSITIONS } from '../../config/inspectionChecklist.js';
import { listRecordImages } from '../../services/inspectionSubmitRules.js';
import {
  mergeDraftAnswers, reconcileDraftAnswers, selectInspectionTemplate,
} from '../../domain/inspection/draftAnswers.js';
import { QuestionType } from '../../domain/inspection/formDefinition.js';

const inspectableStatuses = [CarStatus.DRAFT, CarStatus.INCOMING, CarStatus.REJECTED, CarStatus.UNDER_INSPECTION];
const vehicleFields = ['make', 'model', 'variant', 'color', 'year', 'mileage'];

function inspectionError(code, message, errors) {
  return Object.assign(new Error(message), { code, ...(errors ? { errors } : {}) });
}

function assertObjectId(id, field) {
  if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) {
    throw inspectionError('VALIDATION_ERROR', 'Invalid identifier.', [{ field, message: 'Expected an ObjectId.' }]);
  }
}

function requireNoOpenRecord(record) {
  if (!record) return;
  const code = record.status === InspectionStatus.DRAFT ? 'INSPECTION_DRAFT_EXISTS' : 'INSPECTION_PENDING_APPROVAL';
  throw inspectionError(code, 'The car already has an open inspection.', [
    { field: 'inspectionId', message: String(record.id) },
  ]);
}

function templateUnavailable() {
  return inspectionError('INSPECTION_TEMPLATE_NOT_AVAILABLE', 'No inspection template is available for this car.');
}

function revisionConflict() {
  return inspectionError('FORM_REVISION_CONFLICT', 'The template revision has changed.');
}

async function findCurrentTemplate(templates, templateKey) {
  const template = await templates.findCurrent(templateKey);
  if (!template) throw templateUnavailable();
  return template;
}

async function findInspection(records, id) {
  const record = await records.findById(id);
  if (!record) throw inspectionError('INSPECTION_NOT_FOUND', 'Inspection not found.');
  return record;
}

async function findCar(cars, id) {
  const car = await cars.findById(id);
  if (!car) throw inspectionError('CAR_NOT_FOUND', 'Car not found.');
  return car;
}

async function projectAnswers(templates, record, template) {
  let previousTemplate = template;
  if (record.templateRevision !== template.revision) {
    previousTemplate = record.templateRevision == null
      ? null
      : await templates.findRevision(record.templateKey, record.templateRevision);
    if (!previousTemplate && record.templateRevision != null) throw revisionConflict();
  }
  const projected = reconcileDraftAnswers({
    previousTemplate, currentTemplate: template, answers: record.answers ?? [], archivedAnswers: record.archivedAnswers ?? [],
  });
  if (projected.code) throw inspectionError(projected.code, 'The saved inspection uses a different template.');
  return projected;
}

function getSystemChanges(record, patch) {
  const fields = {};
  const issues = [];
  if (patch.vehicleInfo?.confirmed != null) {
    const confirmed = patch.vehicleInfo.confirmed;
    fields['vehicleInfo.confirmed'] = Object.fromEntries(vehicleFields
      .filter((field) => Object.hasOwn(confirmed, field)).map((field) => [field, confirmed[field]]));
  }
  if (patch.overviewPhotos != null) {
    fields.overviewPhotos = Object.fromEntries(OVERVIEW_POSITIONS.map((pos) => [pos, patch.overviewPhotos[pos] ?? null]));
  }
  if (patch.groups != null) {
    const updates = new Map();
    for (const [index, group] of patch.groups.entries()) {
      const definition = findGroup(group.groupKey);
      const field = `groups.${index}`;
      if (!definition || updates.has(group.groupKey)) {
        issues.push({ field: `${field}.groupKey`, message: 'Unknown or duplicate inspection group.' });
        continue;
      }
      if (group.note?.length > INSPECTION_LIMITS.NOTE_MAX_LENGTH) {
        issues.push({ field: `${field}.note`, message: 'Inspection note is too long.' });
      }
      if (group.odometerPhoto && !definition.requiresOdometerPhoto) {
        issues.push({ field: `${field}.odometerPhoto`, message: 'This group does not accept an odometer photo.' });
      }
      for (const [position, defect] of (group.minorDefects ?? []).entries()) {
        if (!definition.minorDefectTypes.some(({ key }) => key === defect.type)) {
          issues.push({ field: `${field}.minorDefects.${position}.type`, message: 'Defect is not allowed in this group.' });
        }
      }
      const { groupKey, note, photos, odometerPhoto, minorDefects, items } = group;
      const values = { note, photos, odometerPhoto, minorDefects, items };
      updates.set(groupKey, Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)));
    }
    const groups = new Map((record.groups ?? []).map((group) => [group.groupKey, group]));
    for (const [groupKey, values] of updates) {
      groups.set(groupKey, { ...groups.get(groupKey), groupKey, ...values, passed: null });
    }
    fields.groups = [...groups.values()];
  }
  return { fields, issues };
}

function validateImages(patch, template, inspectionId, isInspectionImageUrl) {
  const images = listRecordImages(patch);
  const imageQuestionIds = new Set(template.groups.flatMap(({ questions }) => questions
    .filter(({ type }) => type === QuestionType.IMAGE).map(({ id }) => id)));
  for (const [index, answer] of (patch.answers ?? []).entries()) {
    const { questionId, value } = answer ?? {};
    if (!imageQuestionIds.has(questionId) || !Array.isArray(value)) continue;
    for (const [position, url] of value.entries()) {
      images.push({ field: `answers.${index}.value.${position}`, url });
    }
  }
  return images.filter(({ url }) => isInspectionImageUrl?.(url, inspectionId) !== true)
    .map(({ field }) => ({ field, message: 'Image must be uploaded to this inspection folder.' }));
}

export function createInspectionDraftUseCases({ templates, records, unitOfWork, isInspectionImageUrl }) {
  return {
    /**
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-001
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-002
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-003
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-004
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-028
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-039
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-044
     */
    async createDraft(carId, actorId) {
      assertObjectId(carId, 'carId');
      return unitOfWork.run(async ({ cars, records: writer, templates: reader, audit }) => {
        const car = await findCar(cars, carId);
        if (!inspectableStatuses.includes(car.status)) {
          requireNoOpenRecord(await writer.findOpenByCarId(carId));
          throw inspectionError('INVALID_CAR_STATUS', 'Car cannot be inspected in its current status.');
        }
        const claimed = await cars.claimForInspection(carId, car);
        requireNoOpenRecord(await writer.findOpenByCarId(carId));
        if (!claimed) throw inspectionError('INVALID_CAR_STATUS', 'Car changed before inspection could start.');

        const selection = selectInspectionTemplate(claimed.fuelType);
        if (selection.code) throw templateUnavailable();
        const template = await findCurrentTemplate(reader, selection.templateKey);
        const original = Object.fromEntries(vehicleFields.map((field) => [field, claimed[field] ?? null]));
        const record = await writer.insert({
          carId, status: InspectionStatus.DRAFT, source: InspectionSource.STAFF,
          templateKey: template.templateKey, templateRevision: template.revision, answers: [], archivedAnswers: [],
          createdBy: actorId, updatedBy: actorId, vehicleInfo: { original, confirmed: { ...original } },
          overviewPhotos: Object.fromEntries(OVERVIEW_POSITIONS.map((pos) => [pos, null])),
          groups: template.groups.map(({ key }) => ({ groupKey: key, photos: [], minorDefects: [] })),
        });
        await audit.append({
          eventType: ActivityEventType.INSPECTION_DRAFT_CREATED, performedBy: actorId,
          targetModel: 'InspectionRecord', targetId: record.id, summary: 'Inspection draft created',
          metadata: { carId },
        });
        if (claimed.status !== CarStatus.UNDER_INSPECTION) {
          const next = await cars.updateIfCurrent(carId, claimed, { status: CarStatus.UNDER_INSPECTION });
          if (!next) throw inspectionError('INVALID_CAR_STATUS', 'Car changed before inspection could start.');
          await audit.append({
            eventType: ActivityEventType.CAR_STATUS_CHANGED, performedBy: actorId,
            targetModel: 'Car', targetId: carId, targetCode: claimed.vehicleCode ?? null,
            changes: { before: { status: claimed.status }, after: { status: next.status } },
            summary: 'Inspection started', metadata: { inspectionId: record.id },
          });
        }
        return { ...record, template };
      });
    },

    /**
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-005
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-018
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-019
     */
    async getInspection(inspectionId) {
      assertObjectId(inspectionId, 'id');
      const record = await findInspection(records, inspectionId);
      if (record.status !== InspectionStatus.DRAFT || record.templateKey == null) return record;
      const template = await findCurrentTemplate(templates, record.templateKey);
      const projected = await projectAnswers(templates, record, template);
      return { ...record, ...projected, templateRevision: template.revision, template };
    },

    /**
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-005
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-006
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-007
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-008
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-009
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-045
     */
    async updateDraft(inspectionId, actorId, patch) {
      assertObjectId(inspectionId, 'id');
      return unitOfWork.run(async ({ cars, records: writer, templates: reader }) => {
        const record = await findInspection(writer, inspectionId);
        if (record.status !== InspectionStatus.DRAFT) {
          throw inspectionError('INSPECTION_LOCKED', 'This inspection is locked.');
        }
        const car = await findCar(cars, record.carId);
        const selection = selectInspectionTemplate(car.fuelType, record.templateKey);
        if (selection.code) throw inspectionError(selection.code, 'The car does not match the saved inspection template.');
        if (record.templateKey == null) throw templateUnavailable();
        const template = await findCurrentTemplate(reader, selection.templateKey);
        if (!Number.isSafeInteger(patch.baseRevision) || patch.baseRevision < 1) {
          throw inspectionError('VALIDATION_ERROR', 'Invalid base revision.', [
            { field: 'baseRevision', message: 'Expected a positive base revision.' },
          ]);
        }
        if (template.revision !== patch.baseRevision) throw revisionConflict();
        if (patch.answers != null && !Array.isArray(patch.answers)) {
          throw inspectionError('VALIDATION_ERROR', 'Invalid draft answers.', [
            { field: 'answers', message: 'Expected a list of answers.' },
          ]);
        }

        const projected = await projectAnswers(reader, record, template);
        const { answers, issues } = mergeDraftAnswers(template, projected.answers, patch.answers ?? []);
        const system = getSystemChanges(record, patch);
        const imageIssues = validateImages(patch, template, inspectionId, isInspectionImageUrl);
        const errors = [...issues, ...system.issues, ...imageIssues];
        if (errors.length) throw inspectionError('VALIDATION_ERROR', 'Invalid draft answers or evidence.', errors);

        const updated = await writer.updateIfCurrent(inspectionId, { status: InspectionStatus.DRAFT }, {
          ...system.fields, answers, archivedAnswers: projected.archivedAnswers, templateRevision: template.revision,
          updatedBy: actorId,
        });
        if (!updated) throw inspectionError('INSPECTION_LOCKED', 'This inspection is locked.');
        return { ...updated, template };
      });
    },
  };
}
