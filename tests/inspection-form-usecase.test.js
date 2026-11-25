import { describe, expect, jest, test } from '@jest/globals';
import { ActivityEventType, CarStatus, FuelType, InspectionStatus } from '../src/constants/appConstants.js';
import { CPO_CRITERIA } from '../src/domain/inspection/criteria.js';
import { createInspectionDraftUseCases } from '../src/usecase/inspection/manageDrafts.js';
import { createFormTemplateUseCases } from '../src/usecase/inspection/manageTemplates.js';

const carId = '000000000000000000000001';
const inspectionId = '000000000000000000000002';
const actorId = '000000000000000000000003';
const gas = FuelType.GASOLINE;
const electric = FuelType.ELECTRIC;
const bodyGroup = CPO_CRITERIA[0].key;
const floodGroup = CPO_CRITERIA[1].key;

const question = (id, type = 'TEXT') => ({
  id, type, label: id, required: false,
  config: type === 'IMAGE' ? { minCount: 0, maxCount: 2 } : { maxLength: 40 },
});
const answer = (questionId, value) => ({ questionId, value });

function form(templateKey, revision, questions = []) {
  return {
    templateKey, revision,
    groups: CPO_CRITERIA.map((criterion, index) => ({
      ...criterion,
      questions: [{
        id: `${criterion.key}_result`, label: 'Kết quả', required: true, type: 'SINGLE_CHOICE',
        config: { options: [{ id: 'pass', label: 'Đạt', result: 'PASS' }] },
      }, ...(index === 0 ? questions : [])],
    })),
    retiredIds: { questions: [], options: [] },
  };
}

const car = (overrides = {}) => ({
  id: carId, status: CarStatus.INCOMING, fuelType: electric,
  make: 'VinFast', model: 'VF 8', variant: 'Eco', year: 2025, color: 'White', mileage: 5_000,
  ...overrides,
});

const draft = (overrides = {}) => ({
  id: inspectionId, carId, status: InspectionStatus.DRAFT,
  templateKey: electric, templateRevision: 1, answers: [], archivedAnswers: [],
  vehicleInfo: { original: { make: 'VinFast' }, confirmed: { make: 'VinFast' } },
  groups: [{ groupKey: bodyGroup, note: 'Existing', photos: ['existing-photo'] }],
  ...overrides,
});

function harness({
  vehicle = car(), inspection = null, forms = [form(electric, 1), form(gas, 1)], auditFailure, publishConflict,
} = {}) {
  let saved = { vehicle, inspection, forms, events: [] };
  const history = [...forms];
  function templatesFor(store, revisions) {
    return {
      findCurrent: async (key) => store.forms.find(({ templateKey }) => key === templateKey) ?? null,
      findRevision: async (key, revision) => revisions.find((item) =>
        item.templateKey === key && item.revision === revision) ?? null,
    };
  }
  const publish = jest.fn((working, revisions, next, baseRevision, userId) => {
    if (publishConflict) return null;
    working.forms = working.forms.map((item) => item.templateKey === next.templateKey ? next : item);
    revisions.push(next);
    working.events.push({ templateKey: next.templateKey, baseRevision, changedBy: userId });
    return next;
  });
  const claim = jest.fn((working) => working.vehicle);
  const update = jest.fn((working, fields) => {
    const { 'vehicleInfo.confirmed': confirmed, ...changes } = fields;
    working.inspection = { ...working.inspection, ...changes };
    if (confirmed) working.inspection.vehicleInfo = { ...working.inspection.vehicleInfo, confirmed };
    return working.inspection;
  });
  const unitOfWork = {
    run: jest.fn(async (action) => {
      const working = structuredClone(saved);
      const revisions = [...history];
      const result = await action({
        templates: {
          ...templatesFor(working, revisions),
          publish: async (...args) => publish(working, revisions, ...args),
        },
        cars: {
          findById: async () => working.vehicle,
          claimForInspection: async () => claim(working),
          updateIfCurrent: async (_id, _expected, changes) => {
            working.vehicle = { ...working.vehicle, ...changes };
            return working.vehicle;
          },
        },
        records: {
          findById: async () => working.inspection,
          findOpenByCarId: async () => working.inspection?.status === InspectionStatus.SUBMITTED ? null : working.inspection,
          insert: async (record) => {
            working.inspection = { ...record, id: inspectionId };
            return working.inspection;
          },
          updateIfCurrent: async (_id, expected, changes) => working.inspection.status === expected.status
            ? update(working, changes)
            : null,
        },
        audit: { append: async (event) => {
          if (auditFailure) throw auditFailure;
          working.events.push(event);
        } },
      });
      saved = working;
      history.splice(0, history.length, ...revisions);
      return result;
    }),
  };
  const templates = {
    findCurrent: async (key) => templatesFor(saved, history).findCurrent(key),
    findRevision: async (key, revision) => templatesFor(saved, history).findRevision(key, revision),
  };
  const validPhoto = `https://images.example.test/inspections/${inspectionId}/photo.jpg`;
  return {
    templateOperations: createFormTemplateUseCases({ templates, unitOfWork }),
    draftOperations: createInspectionDraftUseCases({
      templates, records: { findById: async () => saved.inspection }, unitOfWork,
      isInspectionImageUrl: (url, id) => id === inspectionId && url === validPhoto,
    }),
    state: () => saved,
    claim, publish, update, unitOfWork, validPhoto,
  };
}

describe('Checking and publishing inspection templates', () => {
  test('publishes for one template, records the actor and preserves the other template and historical version', async () => {
    const h = harness();
    const old = await h.templateOperations.getTemplate(electric);
    const groups = form(electric, 2, [question('note')]).groups;
    const updated = await h.templateOperations.updateTemplate(electric, actorId, { baseRevision: 1, groups });
    expect(old).toEqual(form(electric, 1));
    expect(updated).toMatchObject({ templateKey: electric, revision: 2, groups });
    expect(await h.templateOperations.getTemplate(gas)).toEqual(form(gas, 1));
    expect(h.state().events).toEqual([{ templateKey: electric, baseRevision: 1, changedBy: actorId }]);
  });

  test('maps a stale revision and a lost publication CAS to a conflict', async () => {
    const h = harness({ publishConflict: true });
    const groups = form(electric, 2).groups;
    await expect(h.templateOperations.updateTemplate(electric, actorId, { baseRevision: 2, groups }))
      .rejects.toMatchObject({ code: 'FORM_REVISION_CONFLICT' });
    expect(h.publish).not.toHaveBeenCalled();
    await expect(h.templateOperations.updateTemplate(electric, actorId, { baseRevision: 1, groups }))
      .rejects.toMatchObject({ code: 'FORM_REVISION_CONFLICT' });
    expect(h.state().events).toEqual([]);
  });

  test('rejects changing a fixed criterion and reusing a retired question ID', async () => {
    const h = harness({ forms: [{
      ...form(electric, 1), retiredIds: { questions: ['retired'], options: [] },
    }] });
    const changedGroups = form(electric, 2).groups;
    changedGroups[0].label = 'Changed';
    await expect(h.templateOperations.updateTemplate(electric, actorId, { baseRevision: 1, groups: changedGroups }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(h.templateOperations.updateTemplate(electric, actorId, {
      baseRevision: 1, groups: form(electric, 2, [question('retired')]).groups,
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', errors: [{ questionId: 'retired' }] });
    expect(h.publish).not.toHaveBeenCalled();
  });
});

describe('Creating and reading inspection drafts', () => {
  test.each([electric, gas])('copies the car, uses the current %s template and logs both changes', async (fuelType) => {
    const h = harness({ vehicle: car({ fuelType }) });
    const created = await h.draftOperations.createDraft(carId, actorId);
    expect(created).toMatchObject({
      status: InspectionStatus.DRAFT, createdBy: actorId, templateKey: fuelType, templateRevision: 1, answers: [],
      vehicleInfo: { original: { model: 'VF 8', mileage: 5_000 }, confirmed: { model: 'VF 8' } },
    });
    expect(created.vehicleInfo.original).toEqual(created.vehicleInfo.confirmed);
    expect(h.state().vehicle.status).toBe(CarStatus.UNDER_INSPECTION);
    expect(h.state().events.map(({ eventType }) => eventType))
      .toEqual([ActivityEventType.INSPECTION_DRAFT_CREATED, ActivityEventType.CAR_STATUS_CHANGED]);
  });

  test.each([
    [InspectionStatus.DRAFT, 'INSPECTION_DRAFT_EXISTS'],
    ['PENDING_APPROVAL', 'INSPECTION_PENDING_APPROVAL'],
  ])('returns the ID of the existing %s record after claiming the vehicle', async (status, code) => {
    const h = harness({ inspection: draft({ status }) });
    await expect(h.draftOperations.createDraft(carId, actorId)).rejects.toMatchObject({
      code, errors: [{ field: 'inspectionId', message: inspectionId }],
    });
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.state().events).toEqual([]);
  });

  test.each([
    [null, 'CAR_NOT_FOUND'],
    [car({ status: CarStatus.AVAILABLE }), 'INVALID_CAR_STATUS'],
    [car({ fuelType: FuelType.DIESEL }), 'INSPECTION_TEMPLATE_NOT_AVAILABLE'],
  ])('rejects an unavailable car or template without recording changes', async (vehicle, code) => {
    const h = harness({ vehicle });
    await expect(h.draftOperations.createDraft(carId, actorId)).rejects.toMatchObject({ code });
    expect(h.state()).toMatchObject({ vehicle, inspection: null, events: [] });
  });

  test('rolls back draft creation when audit fails', async () => {
    const h = harness({ auditFailure: new Error('Audit failed.') });
    await expect(h.draftOperations.createDraft(carId, actorId)).rejects.toThrow('Audit failed.');
    expect(h.state()).toMatchObject({ inspection: null, vehicle: { status: CarStatus.INCOMING }, events: [] });
  });

  test('keeps a locked snapshot and a legacy final record readable without fetching or rewriting a draft', async () => {
    const snapshot = form(electric, 1);
    for (const inspection of [
      draft({ status: 'PENDING_APPROVAL', templateSnapshot: snapshot }),
      { id: inspectionId, carId, status: InspectionStatus.SUBMITTED, source: 'LEGACY' },
    ]) {
      const h = harness({ inspection, forms: [] });
      await expect(h.draftOperations.getInspection(inspectionId)).resolves.toEqual(inspection);
      await expect(h.draftOperations.updateDraft(inspectionId, actorId, { baseRevision: 1 }))
        .rejects.toMatchObject({ code: 'INSPECTION_LOCKED' });
      expect(h.update).not.toHaveBeenCalled();
    }
  });
});

describe('Editing a versioned draft', () => {
  test('projects on read, then preserves compatible answers and archives removed answers on save', async () => {
    const original = draft({ answers: [answer('keep', 'old value'), answer('remove', 'archive')] });
    const h = harness({ inspection: original, forms: [form(electric, 1, [question('keep'), question('remove')])] });
    const next = form(electric, 2, [question('keep'), question('new')]);
    await h.templateOperations.updateTemplate(electric, actorId, { baseRevision: 1, groups: next.groups });

    const projected = await h.draftOperations.getInspection(inspectionId);
    expect(projected).toMatchObject({
      templateRevision: 2, answers: [answer('keep', 'old value')],
      archivedAnswers: [{ ...answer('remove', 'archive'), sourceRevision: 1 }],
    });
    expect(h.state().inspection).toEqual(original);
    expect(h.update).not.toHaveBeenCalled();

    await expect(h.draftOperations.updateDraft(inspectionId, actorId, { baseRevision: 1 }))
      .rejects.toMatchObject({ code: 'FORM_REVISION_CONFLICT' });
    const updated = await h.draftOperations.updateDraft(inspectionId, actorId, {
      baseRevision: 2, answers: [answer('new', 'added')], status: 'SUBMITTED', approvedBy: actorId,
      vehicleInfo: { original: { make: 'Forged' }, confirmed: { make: 'Updated' } },
      groups: [{ groupKey: bodyGroup, note: 'New note', passed: true }],
    });
    expect(updated).toMatchObject({
      status: InspectionStatus.DRAFT, updatedBy: actorId, templateRevision: 2,
      answers: [answer('keep', 'old value'), answer('new', 'added')],
      archivedAnswers: projected.archivedAnswers,
      vehicleInfo: { original: { make: 'VinFast' }, confirmed: { make: 'Updated' } },
      groups: [{ groupKey: bodyGroup, note: 'New note', photos: ['existing-photo'], passed: null }],
    });
    expect(updated).not.toHaveProperty('approvedBy');
  });

  test('rejects a change in the vehicle fuel type and leaves existing answers untouched', async () => {
    const inspection = draft({ answers: [answer('old', 'unchanged')] });
    const h = harness({ vehicle: car({ fuelType: gas }), inspection });
    await expect(h.draftOperations.updateDraft(inspectionId, actorId, { baseRevision: 1 }))
      .rejects.toMatchObject({ code: 'INSPECTION_FORM_TYPE_MISMATCH' });
    expect(h.state().inspection).toEqual(inspection);
  });

  test('validates image answer source and report fields before performing any write', async () => {
    const h = harness({ inspection: draft(), forms: [form(electric, 1, [question('photo', 'IMAGE')])] });
    await expect(h.draftOperations.updateDraft(inspectionId, actorId, {
      baseRevision: 1,
      answers: [answer('unknown', 'bad'), answer('photo', ['https://other.example.test/photo.jpg'])],
      overviewPhotos: { FRONT: 'https://other.example.test/photo.jpg' },
      groups: [{ groupKey: floodGroup, note: 'x'.repeat(1001), minorDefects: [{ type: 'DENT_MINOR' }] }],
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      errors: expect.arrayContaining([
        expect.objectContaining({ field: 'answers.0.questionId' }),
        expect.objectContaining({ field: 'answers.1.value.0' }),
        expect.objectContaining({ field: 'overviewPhotos.FRONT' }),
        expect.objectContaining({ field: 'groups.0.note' }),
        expect.objectContaining({ field: 'groups.0.minorDefects.0.type' }),
      ]),
    });
    expect(h.update).not.toHaveBeenCalled();
    await expect(h.draftOperations.updateDraft(inspectionId, actorId, {
      baseRevision: 1, answers: [answer('photo', [h.validPhoto])],
    })).resolves.toMatchObject({ answers: [answer('photo', [h.validPhoto])] });
  });

  test('distinguishes an invalid identifier and an unavailable record', async () => {
    const h = harness();
    await expect(h.draftOperations.getInspection('invalid')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(h.draftOperations.getInspection(inspectionId)).rejects.toMatchObject({ code: 'INSPECTION_NOT_FOUND' });
  });
});
