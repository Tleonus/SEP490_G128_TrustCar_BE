// src/models/InspectionRecord.js
/**
 * @file InspectionRecord.js
 * @description Model representing a vehicle inspection (CPO) performed on a car.
 * Each record is linked to a Car and the inspector (User).
 */

import mongoose from 'mongoose';

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
      required: true,
    },
    criteria: {
      type: CriteriaSchema,
      required: true,
    },
    odo: {
      type: Number,
      required: true,
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
      required: true,
    },
    cpoCertificateId: {
      type: String,
      trim: true,
      default: null,
    },
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

const InspectionRecord = mongoose.model('InspectionRecord', InspectionRecordSchema);
export default InspectionRecord;
