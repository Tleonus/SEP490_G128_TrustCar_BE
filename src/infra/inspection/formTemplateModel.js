import mongoose from 'mongoose';

const { Schema } = mongoose;

export const inspectionTemplateKeys = Object.freeze(['ELECTRIC', 'GASOLINE']);

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

export const templatePublishedEvent = 'INSPECTION_TEMPLATE_PUBLISHED';

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
