// src/models/InspectionRecord.js
/**
 * @file InspectionRecord.js
 * @description Model representing a vehicle inspection (CPO) performed on a car.
 * Each record is linked to a Car and the inspector (User).
 */

import mongoose from 'mongoose';

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
    // Checklist fields – Pass/Fail values
    chassisCondition: {
      type: String,
      enum: ['PASS', 'FAIL'],
      required: true,
    },
    engineCondition: {
      type: String,
      enum: ['PASS', 'FAIL'],
      required: true,
    },
    floodCheck: {
      type: String,
      enum: ['PASS', 'FAIL'],
      required: true,
    },
    odoVerification: {
      type: String,
      enum: ['PASS', 'FAIL'],
      required: true,
    },
    electricalSystem: {
      type: String,
      enum: ['PASS', 'FAIL'],
      required: true,
    },
    summaryReport: {
      type: String,
      trim: true,
      default: null,
    },
    inspectionDate: {
      type: Date,
      default: () => new Date(),
    },
    // Audit fields
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
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
InspectionRecordSchema.index({ carId: 1 });
InspectionRecordSchema.index({ inspectorId: 1 });
InspectionRecordSchema.index({ inspectionDate: -1 });

const InspectionRecord = mongoose.model('InspectionRecord', InspectionRecordSchema);
export default InspectionRecord;
