// src/models/InspectionRecord.js
/**
 * @file InspectionRecord.js
 * @description Model representing a vehicle inspection (CPO) performed on a car.
 * Each record is linked to a Car and the inspector (User).
 *
 * DRAFT is editable, PENDING_APPROVAL stores the submission for review, and
 * SUBMITTED carries the final verdict. Records predating the digital checklist
 * have no `status` or `source` and read as SUBMITTED/LEGACY.
 */

import mongoose from 'mongoose';
import { FuelType, InspectionStatus, InspectionSource } from '../constants/appConstants.js';
import { ItemResult, OVERVIEW_POSITIONS } from '../config/inspectionChecklist.js';

// Keep existing route switches on their current status constants until activation.
const pendingApproval = 'PENDING_APPROVAL';
export const openInspectionStatuses = Object.freeze([InspectionStatus.DRAFT, pendingApproval]);
const inspectionTemplateKeys = [FuelType.ELECTRIC, FuelType.GASOLINE];

/** The submitter is known once a record leaves DRAFT. */
function requiredForSubmittedRecord() {
  return this.status !== InspectionStatus.DRAFT;
}

function requiredForVerdict() {
  return !openInspectionStatuses.includes(this.status);
}

function requiredForPendingApproval() {
  return this.status === pendingApproval;
}

function requiredForFormVersion() {
  return requiredForPendingApproval.call(this) || this.templateKey != null;
}

const CriteriaSchema = new mongoose.Schema(
  {
    noMajorAccident: {
      type: Boolean,
      required: true,
    },
    noWaterDamage: {
      type: Boolean,
      required: true,
    },
    engineGearboxIntact: {
      type: Boolean,
      required: true,
    },
    verifiedOdo: {
      type: Boolean,
      required: true,
    },
    electricalSystemPassed: {
      type: Boolean,
      required: true,
    },
  },
  { _id: false }
);

// Vehicle identity as listed (original) or as confirmed at the workshop.
const VehicleInfoSchema = new mongoose.Schema(
  {
    make:    { type: String, trim: true, default: null },
    model:   { type: String, trim: true, default: null },
    variant: { type: String, trim: true, default: null },
    color:   { type: String, trim: true, default: null },
    year:    { type: Number, default: null },
    mileage: { type: Number, min: 0, default: null },
  },
  { _id: false }
);

const OverviewPhotosSchema = new mongoose.Schema(
  Object.fromEntries(OVERVIEW_POSITIONS.map((pos) => [pos, { type: String, default: null }])),
  { _id: false }
);

const ChecklistItemSchema = new mongoose.Schema(
  {
    itemKey: { type: String, required: true },
    result:  { type: String, enum: [...Object.values(ItemResult), null], default: null },
    note:    { type: String, trim: true, default: '' },
    photos:  { type: [String], default: [] },
  },
  { _id: false }
);

const MinorDefectSchema = new mongoose.Schema(
  {
    type:        { type: String, required: true },
    location:    { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    photos:      { type: [String], default: [] },
  },
  { _id: false }
);

const ChecklistGroupSchema = new mongoose.Schema(
  {
    groupKey:      { type: String, required: true },
    items:         { type: [ChecklistItemSchema], default: [] },
    note:          { type: String, trim: true, default: '' },
    photos:        { type: [String], default: [] },
    odometerPhoto: { type: String, default: null },
    minorDefects:  { type: [MinorDefectSchema], default: [] },
    passed:        { type: Boolean, default: null }, // computed on submit
  },
  { _id: false }
);

const answerFields = {
  questionId: { type: String, required: true },
  value: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    validate: (value) => typeof value === 'string' || Number.isFinite(value) ||
      (Array.isArray(value) && Array.from(value).every((url) => typeof url === 'string')),
  },
};

const AnswerSchema = new mongoose.Schema(answerFields, { _id: false });
const ArchivedAnswerSchema = new mongoose.Schema({
  ...answerFields,
  sourceRevision: { type: Number, min: 1, validate: Number.isSafeInteger, default: null },
}, { _id: false });

const ChecklistSnapshotSchema = new mongoose.Schema({
  templateKey: { type: String, enum: inspectionTemplateKeys, required: true },
  revision: { type: Number, min: 1, validate: Number.isSafeInteger, required: true },
  groups: { type: [mongoose.Schema.Types.Mixed], required: true, default: undefined },
  retiredIds: { type: mongoose.Schema.Types.Mixed },
}, { _id: false });

const InspectionRecordSchema = new mongoose.Schema(
  {
    carId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Car',
      required: true,
    },
    inspectorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: requiredForSubmittedRecord,
    },
    criteria: {
      type: CriteriaSchema,
      required: requiredForVerdict,
    },
    odo: {
      type: Number,
      required: requiredForVerdict,
      min: 0,
    },
    notes: {
      type: String,
      trim: true,
      default: '',
    },
    evidenceImages: {
      type: [String],
      default: [],
    },
    result: {
      type: String,
      enum: ['PASSED', 'FAILED'],
      required: requiredForVerdict,
    },
    cpoCertificateId: {
      type: String,
      trim: true,
      default: null,
    },

    // ── Digital checklist (no schema default: legacy records stay unset) ──
    status: {
      type: String,
      enum: [...openInspectionStatuses, InspectionStatus.SUBMITTED],
    },
    source: {
      type: String,
      enum: [InspectionSource.STAFF, InspectionSource.ADMIN_QUICK],
    },
    templateKey: { type: String, enum: inspectionTemplateKeys, required: requiredForPendingApproval },
    checklistVersion: { type: String, required: requiredForFormVersion },
    checklistSnapshot: { type: ChecklistSnapshotSchema, required: requiredForPendingApproval },
    answers: { type: [AnswerSchema], default: undefined },
    archivedAnswers: { type: [ArchivedAnswerSchema], default: undefined },
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: requiredForPendingApproval },
    submittedAt: { type: Date, required: requiredForPendingApproval },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },

    // ── Rejection trace (KAN-53) ────────────────────────────────────────────
    // Admin may reject a SUBMITTED record back to DRAFT; the three fields
    // below record who rejected it, when, and why (validated 10-1000 chars).
    rejectedReason:   { type: String, trim: true, minlength: 10, maxlength: 1000 },
    rejectedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectedAt:       { type: Date },
    vehicleInfo: {
      type: new mongoose.Schema(
        { original: VehicleInfoSchema, confirmed: VehicleInfoSchema },
        { _id: false }
      ),
      default: undefined,
    },
    overviewPhotos: { type: OverviewPhotosSchema, default: undefined },
    groups:         { type: [ChecklistGroupSchema], default: undefined },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: 'inspectionrecords',
  }
);

// Indexes for fast lookup
InspectionRecordSchema.index({ carId: 1, createdAt: -1 });
InspectionRecordSchema.index({ inspectorId: 1 });
InspectionRecordSchema.index({ cpoCertificateId: 1 });
// At most one open draft per car; also guards concurrent draft creation.
InspectionRecordSchema.index(
  { carId: 1 },
  {
    unique: true,
    name: 'uniq_draft_per_car',
    partialFilterExpression: { status: InspectionStatus.DRAFT },
  }
);

// T021 installs this index after checking cluster support and duplicate open rows.
export const openInspectionIndex = {
  key: { carId: 1 },
  options: {
    unique: true,
    name: 'uniq_open_inspection_per_car',
    partialFilterExpression: { status: { $in: [...openInspectionStatuses] } },
  },
};

/**
 * Returns a plain copy of a record with the lifecycle defaults applied to
 * records created before the digital checklist (no `status` / `source`).
 * @param {object} record - Mongoose document or lean object
 * @returns {object}
 */
export const withLifecycleDefaults = (record) => {
  const plain = typeof record?.toObject === 'function' ? record.toObject() : { ...record };
  return {
    ...plain,
    status: plain.status || InspectionStatus.SUBMITTED,
    source: plain.source || InspectionSource.LEGACY,
  };
};

const InspectionRecord = mongoose.model('InspectionRecord', InspectionRecordSchema);
export default InspectionRecord;
