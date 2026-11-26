import mongoose from 'mongoose';
import { INSPECTION_LIMITS } from '../../config/inspectionChecklist.js';
import { collectCriterionDefinitionIssues, InspectionTemplateFormat } from '../../domain/inspection/criterionDefinition.js';
import {
  FormTemplateAudit,
  FormTemplateHead,
  FormTemplateProposal,
  FormTemplateRevision,
  inspectionTemplateKeys,
  TemplateProposalStatus,
  templatePublishedEvent,
} from './formTemplateModel.js';
import { createInspectionAuditRepository } from './inspectionAuditRepository.js';

function toTemplate({ templateKey, revision, groups, retiredIds, format }) {
  return { templateKey, revision, groups, retiredIds, ...(format == null ? {} : { format }) };
}

const validRevision = (revision) => Number.isSafeInteger(revision) && revision > 0;
const { DRAFT, PENDING_APPROVAL, APPROVED } = TemplateProposalStatus;

function assertObjectIds(...ids) {
  if (!ids.every((id) => mongoose.isObjectIdOrHexString(id))) {
    throw new TypeError('Expected valid proposal and user IDs.');
  }
}

/**
 * Read immutable revisions and publish by comparing the template head to
 * baseRevision. A publish also appends its audit event in the same transaction.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-040
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-041
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-042
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-043
 */
export function createFormTemplateRepository({
  session,
  headModel = FormTemplateHead,
  revisionModel = FormTemplateRevision,
  auditModel = FormTemplateAudit,
  proposalModel = FormTemplateProposal,
  activityModel,
} = {}) {
  const legacyAudit = createInspectionAuditRepository({ session, model: auditModel });
  const activities = createInspectionAuditRepository({ session, model: activityModel });

  function requireTransaction() {
    if (!session?.inTransaction()) throw new Error('Template writes require an active transaction.');
  }

  async function findRevision(templateKey, revision) {
    if (!inspectionTemplateKeys.includes(templateKey) || !validRevision(revision)) return null;
    const record = await revisionModel.findOne({ templateKey, revision }, null, { session }).lean();
    return record ? toTemplate(record) : null;
  }

  async function saveRevision(template, baseRevision, actorId, createdAt) {
    const { templateKey, groups, retiredIds, format } = template;
    if (!inspectionTemplateKeys.includes(templateKey) ||
        !validRevision(baseRevision) || baseRevision >= Number.MAX_SAFE_INTEGER) {
      throw new TypeError('Template key or base revision is invalid.');
    }
    const revision = baseRevision + 1;
    const write = await headModel.updateOne(
      { templateKey, revision: baseRevision },
      { $set: { revision } },
      { session, runValidators: true },
    );
    if (write.matchedCount !== 1) return null;
    const [saved] = await revisionModel.create([{
      templateKey, revision, groups, retiredIds, createdBy: actorId, createdAt,
      ...(format == null ? {} : { format }),
    }], { session });
    return saved.toObject();
  }

  async function prepareProposalGroups(templateKey, baseRevision, groups) {
    const errors = collectCriterionDefinitionIssues(groups);
    if (errors.length) {
      throw Object.assign(new TypeError('Invalid inspection criteria.'), { code: 'VALIDATION_ERROR', errors });
    }
    if (!validRevision(baseRevision) || baseRevision >= Number.MAX_SAFE_INTEGER ||
        !await findRevision(templateKey, baseRevision)) {
      throw Object.assign(new Error('Invalid inspection proposal base revision.'), { code: 'FORM_REVISION_CONFLICT' });
    }
    return groups.map(({ key, label, required }) => ({ key, label: label.trim(), required }));
  }

  function updateProposal(filter, values) {
    return proposalModel.findOneAndUpdate(
      filter, { $set: values }, { session, new: true, runValidators: true },
    ).lean();
  }

  function proposalVisibility({ actorId, reviewer }) {
    assertObjectIds(actorId);
    return reviewer
      ? { $or: [{ submittedBy: actorId }, { submittedAt: { $ne: null } }] }
      : { submittedBy: actorId };
  }

  return {
    findRevision,
    async findCurrent(templateKey) {
      if (!inspectionTemplateKeys.includes(templateKey)) return null;
      const head = await headModel.findOne({ templateKey }, null, { session }).lean();
      return head ? findRevision(templateKey, head.revision) : null;
    },
    async publish(template, baseRevision, actorId) {
      requireTransaction();
      if (template.format === InspectionTemplateFormat.CRITERIA) {
        throw new TypeError('A criteria revision must be published from an approved proposal.');
      }
      const createdAt = new Date();
      const revision = await saveRevision(template, baseRevision, actorId, createdAt);
      if (!revision) return null;
      await legacyAudit.append({
        eventType: templatePublishedEvent,
        templateKey: revision.templateKey,
        previousRevision: baseRevision,
        revision: revision.revision,
        actorId,
        createdAt,
      });
      return toTemplate(revision);
    },

    /** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#req-047 */
    findProposal(proposalId, viewer) {
      assertObjectIds(proposalId);
      return proposalModel.findOne({ _id: proposalId, ...proposalVisibility(viewer) }, null, { session }).lean();
    },
    async listProposals(viewer, { templateKey, status, before, limit = 20 }) {
      const filter = proposalVisibility(viewer);
      if (templateKey) filter.templateKey = templateKey;
      if (status) filter.status = status;
      if (before) filter._id = { $lt: before };
      const rows = await proposalModel.find(filter, '-groups', { session }).sort({ _id: -1 }).limit(limit + 1).lean();
      const items = rows.slice(0, limit);
      return { items, nextCursor: rows.length > limit ? String(items.at(-1)._id) : null };
    },
    async createProposal({ templateKey, baseRevision, groups, submittedBy }) {
      requireTransaction();
      assertObjectIds(submittedBy);
      const criteria = await prepareProposalGroups(templateKey, baseRevision, groups);
      const [saved] = await proposalModel.create(
        [{ templateKey, baseRevision, groups: criteria, submittedBy, status: DRAFT }], { session },
      );
      return saved.toObject();
    },
    async updateProposalDraft(proposalId, actorId, { baseRevision, groups }) {
      requireTransaction();
      assertObjectIds(proposalId, actorId);
      const filter = { _id: proposalId, submittedBy: actorId, status: DRAFT };
      const proposal = await proposalModel.findOne(filter, { templateKey: 1 }, { session }).lean();
      if (!proposal) return null;
      const criteria = await prepareProposalGroups(proposal.templateKey, baseRevision, groups);
      return updateProposal(filter, { baseRevision, groups: criteria });
    },
    async submitProposal(proposalId, actorId) {
      requireTransaction();
      assertObjectIds(proposalId, actorId);
      return updateProposal({ _id: proposalId, submittedBy: actorId, status: DRAFT }, {
        status: PENDING_APPROVAL, submittedAt: new Date(),
        reviewedBy: null, reviewedAt: null, reviewNote: null,
      });
    },
    async returnProposal(proposalId, actorId, reason) {
      requireTransaction();
      assertObjectIds(proposalId, actorId);
      if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > INSPECTION_LIMITS.NOTE_MAX_LENGTH) {
        throw new TypeError('A valid review reason is required.');
      }
      return updateProposal({ _id: proposalId, status: PENDING_APPROVAL }, {
        status: DRAFT, reviewedBy: actorId, reviewedAt: new Date(), reviewNote: reason.trim(),
      });
    },

    /** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#req-048 */
    async publishProposal(proposalId, actorId) {
      requireTransaction();
      assertObjectIds(proposalId, actorId);
      const proposal = await proposalModel.findById(proposalId, null, { session }).lean();
      if (proposal?.status === APPROVED) {
        const saved = await revisionModel.findById(proposal.publishedRevisionId, null, { session }).lean();
        if (!saved) throw new Error('The approved proposal is missing its published revision.');
        return toTemplate(saved);
      }
      if (proposal?.status !== PENDING_APPROVAL) return null;

      const { templateKey, baseRevision, groups } = proposal;
      const criteria = await prepareProposalGroups(templateKey, baseRevision, groups);
      const createdAt = new Date();
      const revision = await saveRevision({
        templateKey, groups: criteria, retiredIds: { questions: [], options: [] },
        format: InspectionTemplateFormat.CRITERIA,
      }, baseRevision, actorId, createdAt);
      if (!revision) {
        throw Object.assign(new Error('The template revision has changed.'), { code: 'FORM_REVISION_CONFLICT' });
      }

      const updated = await updateProposal({ _id: proposalId, status: PENDING_APPROVAL }, {
        status: APPROVED, reviewedBy: actorId, reviewedAt: createdAt, publishedRevisionId: revision._id,
      });
      if (!updated) throw new Error('The proposal changed during publication.');
      await activities.append({
        eventType: templatePublishedEvent,
        performedBy: actorId,
        targetModel: 'InspectionFormTemplateRevision',
        targetId: revision._id,
        targetCode: templateKey,
        changes: { before: { revision: baseRevision }, after: { revision: revision.revision } },
        createdAt,
      });
      return toTemplate(revision);
    },
  };
}
