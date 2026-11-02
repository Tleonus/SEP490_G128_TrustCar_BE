// src/models/InspectionRecord.js
/**
 * @file InspectionRecord.js
 * @description Model representing a vehicle inspection (CPO) performed on a car.
 * Each record is linked to a Car and the inspector (User).
 *
 * A record is either a DRAFT (digital checklist being filled in, editable) or
 * SUBMITTED (locked, carries the verdict). The 5 KAN-14 booleans, `odo`,
 * `result` and `cpoCertificateId` are derived on submit, so they are only
 * required once the record is no longer a draft. Records created before the
 * checklist existed have no `status`/`source` and are read as SUBMITTED/LEGACY.
 */

import mongoose from 'mongoose';
import { InspectionStatus, InspectionSource } from '../constants/appConstants.js';
import { ItemResult, OVERVIEW_POSITIONS } from '../config/inspectionChecklist.js';

/** Verdict fields are mandatory for every record except a draft. */
function requiredUnlessDraft() {
  return this.status !== InspectionStatus.DRAFT;
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
      required: requiredUnlessDraft,
    },
    criteria: {
      type: CriteriaSchema,
      required: requiredUnlessDraft,
    },
    odo: {
      type: Number,
      required: requiredUnlessDraft,
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
      required: requiredUnlessDraft,
    },
    cpoCertificateId: {
      type: String,
      trim: true,
      default: null,
    },

    // ── Digital checklist (no schema default: legacy records stay unset) ──
    status: {
      type: String,
      enum: [InspectionStatus.DRAFT, InspectionStatus.SUBMITTED],
    },
    source: {
      type: String,
      enum: [InspectionSource.STAFF, InspectionSource.ADMIN_QUICK],
    },
    checklistVersion: { type: String, default: undefined },
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedAt: { type: Date },
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
