import {
  FormTemplateAudit,
  FormTemplateHead,
  FormTemplateRevision,
  inspectionTemplateKeys,
  templatePublishedEvent,
} from './formTemplateModel.js';
import { createInspectionAuditRepository } from './inspectionAuditRepository.js';

function toTemplate({ templateKey, revision, groups, retiredIds }) {
  return { templateKey, revision, groups, retiredIds };
}

const validRevision = (revision) => Number.isSafeInteger(revision) && revision > 0;

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
} = {}) {
  const audit = createInspectionAuditRepository({ session, model: auditModel });

  async function findRevision(templateKey, revision) {
    if (!inspectionTemplateKeys.includes(templateKey) || !validRevision(revision)) return null;
    const record = await revisionModel.findOne({ templateKey, revision }, null, { session }).lean();
    return record ? toTemplate(record) : null;
  }

  return {
    findRevision,
    async findCurrent(templateKey) {
      if (!inspectionTemplateKeys.includes(templateKey)) return null;
      const head = await headModel.findOne({ templateKey }, null, { session }).lean();
      return head ? findRevision(templateKey, head.revision) : null;
    },
    async publish(template, baseRevision, actorId) {
      if (!session?.inTransaction()) throw new Error('Template publication requires an active transaction.');

      const { templateKey, groups, retiredIds } = template;
      const revision = baseRevision + 1;
      if (!inspectionTemplateKeys.includes(templateKey) || !validRevision(baseRevision) || !validRevision(revision)) {
        throw new TypeError('Template key or base revision is invalid.');
      }

      const write = await headModel.updateOne(
        { templateKey, revision: baseRevision },
        { $set: { revision } },
        { session, runValidators: true },
      );
      if (write.matchedCount !== 1) return null;

      const createdAt = new Date();
      const [saved] = await revisionModel.create(
        [{ templateKey, revision, groups, retiredIds, createdBy: actorId, createdAt }],
        { session },
      );
      await audit.append({
        eventType: templatePublishedEvent,
        templateKey,
        previousRevision: baseRevision,
        revision,
        actorId,
        createdAt,
      });
      return toTemplate(saved.toObject());
    },
  };
}
