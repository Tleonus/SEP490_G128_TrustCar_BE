import { describe, expect, jest, test } from '@jest/globals';
import mongoose from 'mongoose';
import { CPO_CRITERIA } from '../src/domain/inspection/criteria.js';
import ActivityLog from '../src/models/ActivityLog.js';
import {
  FormTemplateAudit, FormTemplateHead, FormTemplateProposal, FormTemplateRevision, templatePublishedEvent,
} from '../src/infra/inspection/formTemplateModel.js';
import { createFormTemplateRepository } from '../src/infra/inspection/formTemplateRepository.js';
import { createInspectionUnitOfWork } from '../src/infra/inspection/inspectionUnitOfWork.js';

const actorId = '000000000000000000000001';
const reviewerId = '000000000000000000000002';
const criteria = [
  ...CPO_CRITERIA.map(({ key, label }) => ({ key, label, required: true })),
  { key: 'BODYWORK', label: 'Thân vỏ', required: false },
];
const template = (templateKey, revision, label = 'Kết quả') => ({
  templateKey,
  revision,
  groups: CPO_CRITERIA.map((criterion) => ({
    ...criterion,
    questions: [{
      id: criterion.key, label, required: true, type: 'SINGLE_CHOICE',
      config: { options: [{ id: 'pass', label: 'Đạt', result: 'PASS' }] },
    }],
  })),
  retiredIds: { questions: [], options: [] },
});

function createRepositoryHarness() {
  let committed = {
    heads: { ELECTRIC: 1, GASOLINE: 1 },
    revisions: [template('ELECTRIC', 1), template('GASOLINE', 1)],
    events: [],
    proposals: [],
    activities: [],
  };
  let transactions = Promise.resolve();
  const state = (session) => session?.state ?? committed;
  const headModel = {
    findOne: jest.fn(({ templateKey }, _projection, { session }) => ({
      lean: async () => {
        const revision = state(session).heads[templateKey];
        return revision ? { templateKey, revision } : null;
      },
    })),
    updateOne: jest.fn(async ({ templateKey, revision }, { $set }, { session }) => {
      if (session.state.heads[templateKey] !== revision) return { matchedCount: 0 };
      session.state.heads[templateKey] = $set.revision;
      return { matchedCount: 1 };
    }),
  };
  const revisionModel = {
    findOne: jest.fn(({ templateKey, revision }, _projection, { session }) => ({
      lean: async () => state(session).revisions.find((record) =>
        record.templateKey === templateKey && record.revision === revision) ?? null,
    })),
    findById: jest.fn((id, _projection, { session }) => ({
      lean: async () => state(session).revisions.find(({ _id }) => _id === id) ?? null,
    })),
    create: jest.fn(async ([record], { session }) => {
      const saved = { _id: new mongoose.Types.ObjectId().toHexString(), ...record };
      session.state.revisions.push(saved);
      return [{ toObject: () => saved }];
    }),
  };
  const auditModel = {
    create: jest.fn(async ([event], { session }) => {
      session.state.events.push(event);
    }),
  };
  const match = (row, filter) => Object.entries(filter).every(([key, value]) => row[key] === value);
  const proposalModel = {
    create: jest.fn(async ([proposal], { session }) => {
      const saved = { _id: new mongoose.Types.ObjectId().toHexString(), ...proposal };
      state(session).proposals.push(saved);
      return [{ toObject: () => saved }];
    }),
    findOne: jest.fn((filter, _projection, { session }) => ({
      lean: async () => state(session).proposals.find((row) => match(row, filter)) ?? null,
    })),
    findById: jest.fn((id, _projection, { session }) => ({
      lean: async () => state(session).proposals.find(({ _id }) => _id === id) ?? null,
    })),
    findOneAndUpdate: jest.fn((filter, { $set }, { session }) => ({
      lean: async () => {
        const proposal = state(session).proposals.find((row) => match(row, filter));
        return proposal ? Object.assign(proposal, $set) : null;
      },
    })),
  };
  const activityModel = {
    create: jest.fn(async ([activity], { session }) => {
      await new ActivityLog(activity).validate();
      state(session).activities.push(activity);
    }),
  };
  const bindTemplates = (session) => createFormTemplateRepository({
    session, headModel, revisionModel, auditModel, proposalModel, activityModel,
  });
  const runTransaction = (action) => {
    const work = transactions.then(async () => {
      const session = { state: structuredClone(committed), inTransaction: () => true };
      const result = await action(session);
      committed = session.state;
      return result;
    });
    transactions = work.catch(() => {});
    return work;
  };
  return {
    headModel, revisionModel, auditModel, activityModel, proposalModel, bindTemplates, runTransaction,
    readers: bindTemplates(),
    unitOfWork: createInspectionUnitOfWork({ runTransaction, bindTemplates }),
  };
}

describe('Inspection template persistence', () => {
  test('defines unique version and template head keys and keeps revision data immutable', async () => {
    expect(FormTemplateRevision.schema.indexes()).toContainEqual([
      { templateKey: 1, revision: 1 }, expect.objectContaining({ unique: true }),
    ]);
    expect(FormTemplateHead.schema.indexes()).toContainEqual([
      { templateKey: 1 }, expect.objectContaining({ unique: true }),
    ]);
    for (const field of ['templateKey', 'revision', 'groups', 'retiredIds', 'createdBy', 'createdAt']) {
      expect(FormTemplateRevision.schema.path(field).options.immutable).toBe(true);
    }
    expect(FormTemplateAudit.schema.path('createdAt').options.immutable).toBe(true);
    const record = new FormTemplateRevision({
      ...template('ELECTRIC', 2), createdBy: actorId, createdAt: new Date(),
    });
    await expect(record.validate()).resolves.toBeUndefined();
  });

  test('publishes one revision and one audit event together, leaving the other template and history intact', async () => {
    const h = createRepositoryHarness();
    const updated = {
      ...template('ELECTRIC', 1, 'Nhãn mới'),
      retiredIds: { questions: ['retired'], options: [{ questionId: 'a', optionId: 'b' }] },
    };
    const saved = await h.unitOfWork.run(({ templates }) => templates.publish(updated, 1, actorId));

    expect(saved).toEqual({ ...updated, revision: 2 });
    expect(await h.readers.findCurrent('ELECTRIC')).toEqual(saved);
    expect(await h.readers.findRevision('ELECTRIC', 1)).toEqual(template('ELECTRIC', 1));
    expect(await h.readers.findCurrent('GASOLINE')).toEqual(template('GASOLINE', 1));

    const session = h.headModel.updateOne.mock.calls[0][2].session;
    expect(h.headModel.updateOne).toHaveBeenCalledWith(
      { templateKey: 'ELECTRIC', revision: 1 }, { $set: { revision: 2 } }, { session, runValidators: true },
    );
    expect(h.revisionModel.create).toHaveBeenCalledWith([
      { ...saved, createdBy: actorId, createdAt: expect.any(Date) },
    ], { session });
    expect(h.auditModel.create).toHaveBeenCalledWith([{
      eventType: templatePublishedEvent, templateKey: 'ELECTRIC',
      previousRevision: 1, revision: 2, actorId, createdAt: expect.any(Date),
    }], { session });
  });

  test('allows only one of two requests with the same base revision to publish', async () => {
    const h = createRepositoryHarness();
    const publish = (label) => h.unitOfWork.run(({ templates }) =>
      templates.publish(template('GASOLINE', 1, label), 1, actorId));
    const results = await Promise.all([publish('first'), publish('second')]);

    expect(results).toEqual([template('GASOLINE', 2, 'first'), null]);
    expect(await h.readers.findCurrent('GASOLINE')).toEqual(results[0]);
    expect(h.revisionModel.create).toHaveBeenCalledTimes(1);
    expect(h.auditModel.create).toHaveBeenCalledTimes(1);
  });

  test('rolls back the head and revision when the audit write fails', async () => {
    const h = createRepositoryHarness();
    h.auditModel.create.mockRejectedValueOnce(new Error('Audit write failed.'));

    await expect(h.unitOfWork.run(({ templates }) =>
      templates.publish(template('ELECTRIC', 1, 'failed'), 1, actorId))).rejects.toThrow('Audit write failed.');
    expect(await h.readers.findCurrent('ELECTRIC')).toEqual(template('ELECTRIC', 1));
    expect(await h.readers.findRevision('ELECTRIC', 2)).toBeNull();
  });

  test('refuses publication outside a transaction and rejects invalid keys before writing', async () => {
    const h = createRepositoryHarness();
    await expect(h.readers.publish(template('ELECTRIC', 1), 1, actorId)).rejects.toThrow('active transaction');
    await expect(h.unitOfWork.run(({ templates }) =>
      templates.publish(template({ $ne: 'ELECTRIC' }, 1), 1, actorId))).rejects.toThrow(TypeError);
    expect(h.headModel.updateOne).not.toHaveBeenCalled();
  });
});

describe('Criteria template proposals', () => {
  async function createProposal(h, { submit = true } = {}) {
    const draft = await h.unitOfWork.run(({ templates }) => templates.createProposal({
      templateKey: 'ELECTRIC', baseRevision: 1, groups: criteria, submittedBy: actorId,
    }));
    if (submit) {
      await h.unitOfWork.run(({ templates }) => templates.submitProposal(draft._id, actorId));
    }
    return draft._id;
  }

  test('matches the ERD for proposals and keeps the format optional on old revisions', async () => {
    const draft = new FormTemplateProposal({
      templateKey: 'ELECTRIC', baseRevision: 1, groups: criteria, submittedBy: actorId,
    });
    await expect(draft.validate()).resolves.toBeUndefined();
    expect(draft.groups[0]._id).toBeUndefined();
    expect(draft.status).toBe('DRAFT');
    expect(FormTemplateProposal.schema.indexes()).toContainEqual([
      { publishedRevisionId: 1 },
      expect.objectContaining({ unique: true, partialFilterExpression: { publishedRevisionId: { $type: 'objectId' } } }),
    ]);
    expect(FormTemplateRevision.schema.path('format').options).toMatchObject({ immutable: true });
    expect(new FormTemplateRevision(template('ELECTRIC', 1)).format).toBeUndefined();
  });

  test('locks edits after submission, restricts draft edits to the author, and allows return to draft', async () => {
    const h = createRepositoryHarness();
    const id = await createProposal(h, { submit: false });
    await expect(h.unitOfWork.run(({ templates }) => templates.submitProposal(id, reviewerId))).resolves.toBeNull();
    await expect(h.unitOfWork.run(({ templates }) => templates.submitProposal(id, actorId))).resolves.toMatchObject(
      { status: 'PENDING_APPROVAL', submittedAt: expect.any(Date) },
    );
    const edits = { baseRevision: 1, groups: criteria };
    await expect(h.unitOfWork.run(({ templates }) =>
      templates.updateProposalDraft(id, actorId, edits))).resolves.toBeNull();
    await expect(h.unitOfWork.run(({ templates }) =>
      templates.returnProposal(id, reviewerId, 'Rà lại tiêu chí'))).resolves.toMatchObject({
      status: 'DRAFT', reviewedBy: reviewerId, reviewNote: 'Rà lại tiêu chí',
    });
    await expect(h.unitOfWork.run(({ templates }) =>
      templates.updateProposalDraft(id, actorId, edits))).resolves.toMatchObject({ status: 'DRAFT' });
    expect(await h.readers.findCurrent('ELECTRIC')).toEqual(template('ELECTRIC', 1));
  });

  test('publishes one immutable revision per proposal, logs once and rejects a competing base revision', async () => {
    const h = createRepositoryHarness();
    const id = await createProposal(h);
    const competingId = await createProposal(h);
    const approve = (proposalId) => h.unitOfWork.run(({ templates }) =>
      templates.publishProposal(proposalId, reviewerId));

    const [winner, loser] = await Promise.allSettled([approve(id), approve(competingId)]);
    expect(winner.value).toMatchObject({ format: 'CRITERIA', groups: criteria, revision: 2 });
    expect(loser.reason).toMatchObject({ code: 'FORM_REVISION_CONFLICT' });
    await expect(approve(id)).resolves.toEqual(winner.value);
    expect(await h.readers.findCurrent('ELECTRIC')).toEqual(winner.value);
    expect(await h.readers.findRevision('ELECTRIC', 1)).toEqual(template('ELECTRIC', 1));

    expect(h.activityModel.create).toHaveBeenCalledTimes(1);
    const [[entry], { session }] = h.activityModel.create.mock.calls[0];
    expect(entry).toEqual({
      eventType: templatePublishedEvent, performedBy: reviewerId, targetModel: 'InspectionFormTemplateRevision',
      targetId: session.state.proposals.find(({ _id }) => _id === id).publishedRevisionId,
      targetCode: 'ELECTRIC', changes: { before: { revision: 1 }, after: { revision: 2 } },
      createdAt: expect.any(Date),
    });
    expect(h.headModel.updateOne.mock.calls[0][2].session).toBe(session);
    expect(h.revisionModel.create.mock.calls[0][1].session).toBe(session);
    expect(session.state.proposals.find(({ _id }) => _id === competingId).status).toBe('PENDING_APPROVAL');
    expect(h.auditModel.create).not.toHaveBeenCalled();
  });

  test('aborts all proposal publication writes on activity log failure', async () => {
    const h = createRepositoryHarness();
    const id = await createProposal(h);
    h.activityModel.create.mockRejectedValueOnce(new Error('Activity write failed.'));
    const approve = () => h.unitOfWork.run(({ templates }) => templates.publishProposal(id, reviewerId));
    await expect(approve()).rejects.toThrow('Activity write failed.');
    await expect(h.readers.findCurrent('ELECTRIC')).resolves.toEqual(template('ELECTRIC', 1));
    await expect(h.readers.findRevision('ELECTRIC', 2)).resolves.toBeNull();
    await expect(approve()).resolves.toMatchObject({ revision: 2 });
    expect(h.activityModel.create.mock.calls[1][1].session.state.activities).toHaveLength(1);
  });
});

describe('Inspection unit of work', () => {
  test('uses a fresh transaction after a transient conflict and returns a stale publish result', async () => {
    const h = createRepositoryHarness();
    const transient = Object.assign(new Error('Write conflict.'), {
      hasErrorLabel: (label) => label === 'TransientTransactionError',
    });
    const runTransaction = jest.fn(h.runTransaction).mockImplementationOnce(async (action) => {
      h.headModel.updateOne.mockRejectedValueOnce(transient);
      try {
        await h.runTransaction(action);
      } catch (error) {
        if (error !== transient) throw error;
        await h.unitOfWork.run(({ templates }) =>
          templates.publish(template('ELECTRIC', 1, 'winner'), 1, actorId));
        throw error;
      }
    });
    const unitOfWork = createInspectionUnitOfWork({ runTransaction, bindTemplates: h.bindTemplates });

    const result = await unitOfWork.run(({ templates }) =>
      templates.publish(template('ELECTRIC', 1, 'contender'), 1, actorId));

    expect(result).toBeNull();
    expect(runTransaction).toHaveBeenCalledTimes(2);
    expect(h.auditModel.create).toHaveBeenCalledTimes(1);
    expect(await h.readers.findCurrent('ELECTRIC')).toEqual(template('ELECTRIC', 2, 'winner'));
  });

  test('binds all repositories to the same session and aborts on a non-transient error', async () => {
    const session = {
      startTransaction: jest.fn(), commitTransaction: jest.fn(), abortTransaction: jest.fn(),
      endSession: jest.fn(), inTransaction: () => true,
    };
    const startSession = jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    const bindTemplates = jest.fn();
    const bindAudit = jest.fn();
    const bindRecords = jest.fn();
    const bindCars = jest.fn();
    const bindResults = jest.fn();
    try {
      const unitOfWork = createInspectionUnitOfWork({ bindTemplates, bindAudit, bindRecords, bindCars, bindResults });
      await expect(unitOfWork.run(async () => { throw new Error('Failed write.'); })).rejects.toThrow('Failed write.');
      expect(startSession).toHaveBeenCalledTimes(1);
      for (const bind of [bindTemplates, bindAudit, bindRecords, bindCars]) {
        expect(bind).toHaveBeenCalledWith(session);
      }
      expect(bindResults).toHaveBeenCalledWith(session, undefined);
      expect(session.abortTransaction).toHaveBeenCalledTimes(1);
      expect(session.commitTransaction).not.toHaveBeenCalled();
      expect(session.endSession).toHaveBeenCalledTimes(1);
    } finally {
      startSession.mockRestore();
    }
  });
});
