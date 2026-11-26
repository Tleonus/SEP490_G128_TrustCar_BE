import Joi from 'joi';
import { FuelType } from '../../constants/appConstants.js';
import { INSPECTION_LIMITS as limits, OVERVIEW_POSITIONS } from '../../config/inspectionChecklist.js';
import { CPO_CRITERIA, InspectionResult } from '../../domain/inspection/criteria.js';
import { QuestionType } from '../../domain/inspection/formDefinition.js';
import { criterionKeyMaxLength, criterionKeyPattern, TemplateProposalStatus } from '../../domain/inspection/criterionDefinition.js';

const revision = Joi.number().integer().min(1).strict().required();
const photo = Joi.string().trim().uri({ scheme: ['https'] }).max(500);
const note = Joi.string().trim().allow('').max(limits.NOTE_MAX_LENGTH);
const vehicleText = Joi.string().trim().allow('', null).max(limits.VEHICLE_TEXT_MAX_LENGTH);
const groupKeys = CPO_CRITERIA.map(({ key }) => key);

const templateKey = Joi.string().valid(FuelType.ELECTRIC, FuelType.GASOLINE);
export const templateKeyParams = Joi.object({ templateKey: templateKey.required() }).required();

export const proposalDraftBody = Joi.object({
  baseRevision: revision,
  groups: Joi.array().min(1).unique('key').items(Joi.object({
    key: Joi.string().pattern(criterionKeyPattern).max(criterionKeyMaxLength).required(),
    label: Joi.string().required(),
    required: Joi.boolean().required(),
  })).required(),
}).required();
export const proposalCreateBody = proposalDraftBody.keys({ templateKey: templateKey.required() });
export const proposalListQuery = Joi.object({
  templateKey,
  status: Joi.string().valid(...Object.values(TemplateProposalStatus)),
  before: Joi.string().hex().length(24),
  limit: Joi.number().integer().min(1).max(100).default(20),
});
export const proposalReturnBody = Joi.object({
  reason: Joi.string().pattern(/\S/u).max(limits.NOTE_MAX_LENGTH).required(),
}).required();
export const emptyProposalAction = Joi.object({});

/** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-046 */
export const submitBody = Joi.object({ baseRevision: revision }).required();

const confirmedInfo = Joi.object({
  make: vehicleText,
  model: vehicleText,
  variant: vehicleText,
  color: vehicleText,
  year: Joi.number().integer().min(limits.MIN_YEAR).max(new Date().getFullYear() + 1).allow(null),
  mileage: Joi.number().integer().min(0).allow(null),
}).required();

const minorDefect = Joi.object({
  type: Joi.string().required(),
  location: Joi.string().trim().allow('').max(limits.VEHICLE_TEXT_MAX_LENGTH * 2),
  description: note,
  photos: Joi.array().items(photo).max(limits.MINOR_DEFECT_PHOTOS_MAX),
});

/** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-009 */
export const draftPatch = Joi.object({
  baseRevision: revision,
  odo: Joi.number().integer().min(0).strict(),
  results: Joi.array().unique('criterionId').items(Joi.object({
    criterionId: Joi.string().pattern(criterionKeyPattern).max(criterionKeyMaxLength).required(),
    outcome: Joi.string().valid(...Object.values(InspectionResult)).required(),
    note,
    evidenceImages: Joi.array().items(photo).max(limits.ITEM_PHOTOS_MAX),
  })),
  answers: Joi.array().items(Joi.object({
    questionId: Joi.string().required(),
    value: Joi.alternatives().try(Joi.string().allow(''), Joi.number().strict(), Joi.array().items(photo))
      .allow(null).required(),
  })),
  vehicleInfo: Joi.object({ confirmed: confirmedInfo }),
  overviewPhotos: Joi.object(Object.fromEntries(OVERVIEW_POSITIONS.map((position) => [position, photo.allow(null)]))),
  groups: Joi.array().max(groupKeys.length).unique('groupKey').items(Joi.object({
    groupKey: Joi.string().valid(...groupKeys).required(),
    note,
    photos: Joi.array().items(photo).max(limits.GROUP_PHOTOS_MAX),
    odometerPhoto: photo.allow(null),
    minorDefects: Joi.array().items(minorDefect).max(limits.MINOR_DEFECTS_MAX),
  })),
}).required();

const option = Joi.object({
  id: Joi.string().required(),
  label: Joi.string().required(),
  result: Joi.string().valid(...Object.values(InspectionResult)).allow(null),
});
const minCount = Joi.number().integer().min(0).required();
const maxCount = Joi.number().integer().min(1).required();
const question = Joi.object({
  id: Joi.string().required(),
  label: Joi.string().required(),
  required: Joi.boolean().required(),
  type: Joi.string().valid(...Object.values(QuestionType)).required(),
  config: Joi.alternatives().conditional('type', {
    switch: [
      { is: QuestionType.TEXT, then: Joi.object({ maxLength: maxCount }) },
      { is: QuestionType.NUMBER, then: Joi.object({
        min: Joi.number(), max: Joi.number(), integer: Joi.boolean(), unit: Joi.string(),
      }) },
      { is: QuestionType.IMAGE, then: Joi.object({ minCount, maxCount }) },
      { is: QuestionType.SINGLE_CHOICE, then: Joi.object({ options: Joi.array().items(option).min(1).required() }) },
    ],
  }).required(),
});

/** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-042 */
export const templateBody = Joi.object({
  baseRevision: revision,
  groups: Joi.array().length(groupKeys.length).items(Joi.object({
    key: Joi.string().valid(...groupKeys).required(),
    label: Joi.string().required(),
    criteriaKey: Joi.string().valid(...CPO_CRITERIA.map(({ criteriaKey }) => criteriaKey)),
    required: Joi.boolean().valid(true),
    questions: Joi.array().items(question).required(),
  })).required(),
}).required();
