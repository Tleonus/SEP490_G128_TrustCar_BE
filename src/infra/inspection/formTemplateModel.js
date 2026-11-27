import mongoose from 'mongoose';
import {
  collectCriterionDefinitionIssues, criterionKeyMaxLength, criterionKeyPattern, InspectionTemplateFormat, TemplateProposalStatus,
} from '../../domain/inspection/criterionDefinition.js';
import { INSPECTION_LIMITS } from '../../config/inspectionChecklist.js';
import { ActivityEventType } from '../../constants/appConstants.js';

const { Schema } = mongoose;

export const inspectionTemplateKeys = Object.freeze(['ELECTRIC', 'GASOLINE']);
export { TemplateProposalStatus };

const templateKeyField = () => ({
  type: String, required: true, enum: inspectionTemplateKeys, immutable: true,
});
const revisionField = () => ({
  type: Number, required: true, min: 1, validate: Number.isSafeInteger,
});

const retiredOptionSchema = new Schema({
  questionId: { type: String, required: true },
  optionId: { type: String, required: true },
}, { _id: false });

const retiredIdsSchema = new Schema({
  questions: { type: [String], default: [] },
  options: { type: [retiredOptionSchema], default: [] },
}, { _id: false });

const revisionSchema = new Schema({
  templateKey: templateKeyField(),
  revision: { ...revisionField(), immutable: true },
  format: { type: String, enum: Object.values(InspectionTemplateFormat), immutable: true },
  groups: { type: [Schema.Types.Mixed], required: true, default: undefined, immutable: true },
  retiredIds: { type: retiredIdsSchema, required: true, immutable: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  createdAt: { type: Date, required: true, immutable: true },
}, { collection: 'inspection_form_template_revisions', versionKey: false });

revisionSchema.index({ templateKey: 1, revision: 1 }, { unique: true });

const headSchema = new Schema({
  templateKey: templateKeyField(),
  revision: revisionField(),
}, { collection: 'inspection_form_template_heads', versionKey: false });

headSchema.index({ templateKey: 1 }, { unique: true });

const criterionSchema = new Schema({
  key: { type: String, required: true, match: criterionKeyPattern, maxlength: criterionKeyMaxLength },
  label: { type: String, required: true, trim: true },
  required: { type: Boolean, required: true },
}, { _id: false });

const proposalSchema = new Schema({
  templateKey: templateKeyField(),
  baseRevision: revisionField(),
  groups: {
    type: [criterionSchema], required: true, default: undefined,
    validate: (groups) => collectCriterionDefinitionIssues(groups).length === 0,
  },
  status: { type: String, enum: Object.values(TemplateProposalStatus), default: TemplateProposalStatus.DRAFT },
  submittedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  submittedAt: { type: Date, default: null },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  reviewNote: { type: String, trim: true, maxlength: INSPECTION_LIMITS.NOTE_MAX_LENGTH, default: null },
  publishedRevisionId: { type: Schema.Types.ObjectId, ref: 'InspectionFormTemplateRevision', default: null },
}, {
  collection: 'inspection_form_template_proposals', versionKey: false, autoCreate: false, autoIndex: false,
});

proposalSchema.index(
  { publishedRevisionId: 1 },
  { unique: true, partialFilterExpression: { publishedRevisionId: { $type: 'objectId' } } },
);

export const templatePublishedEvent = ActivityEventType.INSPECTION_TEMPLATE_PUBLISHED;

const templateAuditSchema = new Schema({
  eventType: { type: String, enum: [templatePublishedEvent], required: true, immutable: true },
  templateKey: templateKeyField(),
  previousRevision: { ...revisionField(), immutable: true },
  revision: { ...revisionField(), immutable: true },
  actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  createdAt: { type: Date, required: true, immutable: true },
}, { collection: 'inspection_form_template_audit', versionKey: false });

export const FormTemplateRevision = mongoose.model('InspectionFormTemplateRevision', revisionSchema);
export const FormTemplateHead = mongoose.model('InspectionFormTemplateHead', headSchema);
export const FormTemplateAudit = mongoose.model('InspectionFormTemplateAudit', templateAuditSchema);
export const FormTemplateProposal = mongoose.model('InspectionFormTemplateProposal', proposalSchema);
