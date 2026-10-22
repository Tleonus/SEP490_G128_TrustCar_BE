/**
 * @file Lead.js
 * @description CRM Sales Opportunity (Lead) model for the TrustCar platform.
 *
 * A Lead represents a potential sale: one Customer × one Car × one pipeline stage.
 *
 * Key constraints:
 * - leadCode auto-generated (LD-NNNN format) by leadService.js.
 * - Stage transitions are forward-only per LEAD_STAGE_TRANSITIONS (GBR-17).
 * - LeadActivity entries are append-only; no service permits deletion (GBR-18).
 * - Soft-delete only via isActive=false (GBR-25).
 */

import mongoose from 'mongoose';
import { LeadStage } from '../constants/appConstants.js';

// ── Subdocument: Lead Activity Entry (Append-Only) ─────────────────────────
// Ref: GBR-18
const LeadActivitySchema = new mongoose.Schema(
  {
    type: {
      type:    String,
      enum:    ['NOTE', 'CALL', 'EMAIL', 'VISIT', 'STAGE_CHANGE', 'APPOINTMENT', 'OTHER'],
      default: 'NOTE',
    },
    note: {
      type:      String,
      trim:      true,
      maxlength: [2000, 'Activity note cannot exceed 2000 characters.'],
      default:   null,
    },
    performedBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    performedAt: {
      type:    Date,
      default: () => new Date(),
    },
    metadata: {
      type:    mongoose.Schema.Types.Mixed,
      default: null,
      // e.g., { previousStage: 'NEW', newStage: 'CONTACTED' } for STAGE_CHANGE
    },
  },
  { _id: true, versionKey: false }
);

// ── Main Lead Schema ───────────────────────────────────────────────────────
const LeadSchema = new mongoose.Schema(
  {
    leadCode: {
      type:   String,
      unique: true,
      trim:   true,
      // Auto-generated: LD-NNNN (GBR-13 style) by leadService.js
    },

    // ── Relationships ──────────────────────────────────────────────────
    customer: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Customer',
      required: [true, 'Customer reference is required.'],
      index:    true,
    },

    car: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Car',
      required: [true, 'Car reference is required.'],
      index:    true,
    },

    assignedTo: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
      index:   true,
    },

    // ── Pipeline ───────────────────────────────────────────────────────
    stage: {
      type:    String,
      enum:    {
        values:  Object.values(LeadStage),
        message: 'Stage must be one of: ' + Object.values(LeadStage).join(', '),
      },
      default: LeadStage.NEW,
      index:   true,
    },

    source: {
      type:    String,
      trim:    true,
      default: null,
      // e.g., 'Walk-in', 'Facebook Ad', 'Referral', 'Phone Inquiry'
    },

    priority: {
      type:    String,
      enum:    ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
      default: 'MEDIUM',
    },

    expectedCloseDate: {
      type:    Date,
      default: null,
    },

    // ── Outcome Fields ─────────────────────────────────────────────────
    lostReason: {
      type:      String,
      trim:      true,
      maxlength: 500,
      default:   null,
      // Populated when stage = LOST
    },

    wonAt: {
      type:    Date,
      default: null,
    },

    // ── Activity Log (Append-Only) ─────────────────────────────────────
    // Ref: GBR-18
    activities: {
      type:    [LeadActivitySchema],
      default: [],
    },

    // ── Status ────────────────────────────────────────────────────────
    isActive: {
      type:    Boolean,
      default: true,
    },

    // ── Audit ─────────────────────────────────────────────────────────
    createdBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },

    updatedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
  },
  {
    timestamps:  true,
    versionKey:  false,
    collection:  'leads',
  }
);

// ── Indexes ────────────────────────────────────────────────────────────────
LeadSchema.index({ leadCode: 1 });
LeadSchema.index({ customer: 1 });
LeadSchema.index({ car: 1 });
LeadSchema.index({ assignedTo: 1, stage: 1 });
LeadSchema.index({ stage: 1, isActive: 1 });
LeadSchema.index({ createdAt: -1 });

const Lead = mongoose.model('Lead', LeadSchema);
export default Lead;
