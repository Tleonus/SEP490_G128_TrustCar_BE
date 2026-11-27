import mongoose from 'mongoose';
import {
  collectCriterionDefinitionIssues, InspectionTemplateFormat,
} from '../../domain/inspection/criterionDefinition.js';
import { InspectionResult as Outcome } from '../../domain/inspection/criteria.js';
import User from '../../models/User.js';
import { AppError } from '../../utils/apiResponse.js';
import { FormTemplateRevision, inspectionTemplateKeys } from '../inspection/formTemplateModel.js';
import InspectionResult from '../inspection/inspectionResultModel.js';

const notFound = () => new AppError('Inspection report not found.', 404, 'INSPECTION_REPORT_NOT_FOUND');
const objectId = (value) => mongoose.isObjectIdOrHexString(value) ? new mongoose.Types.ObjectId(value) : null;

/**
 * Read the immutable revision used at certification. For the JSON report, the
 * inspector name is loaded in the same query to keep the three-read budget.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#req-051
 */
export function createCertificateCriteriaReader({ revisionModel = FormTemplateRevision } = {}) {
  return async function readCertificateCriteria(record, { includeInspector = false } = {}) {
    const { templateKey, checklistVersion, checklistSnapshot } = record;
    // Historical forms with a submitted snapshot retain their existing representation.
    if (checklistSnapshot != null || templateKey == null || checklistVersion == null || checklistVersion === '1.0') {
      return null;
    }

    const revision = Number(checklistVersion);
    const inspectionId = objectId(record._id);
    if (!inspectionTemplateKeys.includes(templateKey) || typeof checklistVersion !== 'string' ||
        !Number.isSafeInteger(revision) || revision < 1 || String(revision) !== checklistVersion || !inspectionId) {
      throw notFound();
    }

    const inspectorId = includeInspector ? objectId(record.submittedBy) ?? objectId(record.inspectorId) : null;
    const pipeline = [
      { $match: { templateKey, revision } },
      { $limit: 1 },
      { $project: { _id: 0, format: 1, groups: 1 } },
      {
        $lookup: {
          from: InspectionResult.collection.name,
          let: { format: '$format' },
          pipeline: [
            {
              $match: {
                inspectionId,
                outcome: Outcome.PASS,
                $expr: { $eq: ['$$format', InspectionTemplateFormat.CRITERIA] },
              },
            },
            { $project: { _id: 0, criterionId: 1 } },
          ],
          as: 'passedResults',
        },
      },
    ];
    if (inspectorId) {
      pipeline.push({
        $lookup: {
          from: User.collection.name,
          pipeline: [{ $match: { _id: inspectorId } }, { $project: { _id: 0, fullName: 1 } }],
          as: 'inspectors',
        },
      });
    }

    const [template] = await revisionModel.aggregate(pipeline);
    if (!template) throw notFound();
    const inspectorName = template.inspectors?.[0]?.fullName;
    const details = includeInspector ? { inspectorName: typeof inspectorName === 'string' ? inspectorName : null } : {};
    if (template.format == null || template.format === InspectionTemplateFormat.QUESTIONNAIRE) return details;
    if (template.format !== InspectionTemplateFormat.CRITERIA || collectCriterionDefinitionIssues(template.groups).length) {
      throw notFound();
    }

    const passed = new Set(template.passedResults.map(({ criterionId }) => criterionId));
    return {
      ...details,
      criteriaGroups: template.groups.filter(({ key }) => passed.has(key))
        .map(({ key, label }) => ({ key, label, passed: true })),
    };
  };
}

export const readCertificateCriteria = createCertificateCriteriaReader();
