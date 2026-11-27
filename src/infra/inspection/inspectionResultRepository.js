import mongoose from 'mongoose';
import { INSPECTION_LIMITS } from '../../config/inspectionChecklist.js';
import { InspectionStatus } from '../../constants/appConstants.js';
import { InspectionResult as Outcome } from '../../domain/inspection/criteria.js';
import { isCriterionKey, InspectionTemplateFormat } from '../../domain/inspection/criterionDefinition.js';
import InspectionRecord from '../../models/InspectionRecord.js';
import InspectionResult from './inspectionResultModel.js';

function resultError(code, message) {
  return Object.assign(new Error(message), { code });
}

function validatedScores(scores) {
  if (!Array.isArray(scores)) throw resultError('VALIDATION_ERROR', 'Expected a list of criterion results.');
  const keys = new Set();
  return Array.from(scores, (score) => {
    const { criterionId, outcome, note = '', evidenceImages = [] } = score ?? {};
    if (!isCriterionKey(criterionId) || keys.has(criterionId)) {
      throw resultError('VALIDATION_ERROR', 'Expected unique and valid criterion IDs.');
    }
    if (!Object.values(Outcome).includes(outcome) || typeof note !== 'string' ||
        note.trim().length > INSPECTION_LIMITS.NOTE_MAX_LENGTH || !Array.isArray(evidenceImages) ||
        evidenceImages.length > INSPECTION_LIMITS.ITEM_PHOTOS_MAX ||
        !Array.from(evidenceImages).every((image) => typeof image === 'string' && image.length <= 500 &&
          /^https:\/\//i.test(image) && URL.canParse(image))) {
      throw resultError('VALIDATION_ERROR', 'Invalid criterion outcome, note, or evidence images.');
    }
    keys.add(criterionId);
    return { criterionId, outcome, note: note.trim(), evidenceImages };
  });
}

/**
 * Persist criterion results using the same transaction as the draft update.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#req-049
 */
export function createInspectionResultRepository({
  session, templates, model = InspectionResult, recordModel = InspectionRecord,
} = {}) {
  async function saveDraftResults(inspectionId, expectedRevision, scores) {
    if (!session?.inTransaction()) throw new Error('Inspection result writes require an active transaction.');
    if (!mongoose.isObjectIdOrHexString(inspectionId) || !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 1) {
      throw resultError('VALIDATION_ERROR', 'Expected a valid inspection ID and revision.');
    }
    const rows = validatedScores(scores);
    if (!rows.length) return [];
    const record = await recordModel.findById(
      inspectionId, { status: 1, templateKey: 1, checklistVersion: 1, updatedAt: 1 }, { session },
    ).lean();
    if (!record) throw resultError('INSPECTION_NOT_FOUND', 'Inspection not found.');
    if (record.status !== InspectionStatus.DRAFT) throw resultError('INSPECTION_LOCKED', 'The inspection is locked.');
    if (record.checklistVersion !== String(expectedRevision)) {
      throw resultError('FORM_REVISION_CONFLICT', 'The inspection revision has changed.');
    }

    const template = await templates.findRevision(record.templateKey, expectedRevision);
    if (template?.format !== InspectionTemplateFormat.CRITERIA) {
      throw resultError('INSPECTION_TEMPLATE_NOT_AVAILABLE', 'The inspection does not use a criteria template.');
    }
    const templateKeys = new Set(template.groups.map(({ key }) => key));
    if (rows.some(({ criterionId }) => !templateKeys.has(criterionId))) {
      throw resultError('VALIDATION_ERROR', 'The criterion is not on this inspection revision.');
    }

    // Touch the draft so a competing submission cannot commit past this result write.
    const updatedAt = new Date(Math.max(Date.now(), (record.updatedAt?.getTime() ?? 0) + 1));
    const update = await recordModel.updateOne({
      _id: inspectionId, status: InspectionStatus.DRAFT, templateKey: record.templateKey,
      checklistVersion: record.checklistVersion, updatedAt: record.updatedAt ?? null,
    }, { $set: { updatedAt } }, { session, timestamps: false });
    if (update.matchedCount !== 1) throw resultError('INSPECTION_LOCKED', 'The draft changed during the result write.');

    const saved = [];
    for (const { criterionId, ...fields } of rows) {
      saved.push(await model.findOneAndUpdate(
        { inspectionId, criterionId },
        { $set: fields },
        { session, new: true, upsert: true, runValidators: true },
      ).lean());
    }
    return saved;
  }

  return {
    async findByInspectionId(inspectionId) {
      if (!mongoose.isObjectIdOrHexString(inspectionId)) return [];
      return model.find({ inspectionId }, null, { session }).sort({ criterionId: 1 }).lean();
    },
    async saveDraftResult(inspectionId, expectedRevision, score) {
      const [saved] = await saveDraftResults(inspectionId, expectedRevision, [score]);
      return saved;
    },
    saveDraftResults,
  };
}
