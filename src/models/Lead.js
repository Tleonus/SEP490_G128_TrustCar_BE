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
import { SCORE_BAND, SCORE_MAX } from '../constants/leadScoringConstants.js';

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

    // Nullable: a general "contact us" enquiry names no specific vehicle.
    car: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Car',
      default:  null,
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

    // ── Enquiry snapshot ───────────────────────────────────────────────
    // Captured verbatim from the public contact form so the sales team reads
    // exactly what the visitor typed, even if the Customer record is edited later.
    enquiry: {
      message: {
        type:      String,
        trim:      true,
        maxlength: [2000, 'Enquiry message cannot exceed 2000 characters.'],
        default:   null,
      },
      submittedName: {
        type:      String,
        trim:      true,
        maxlength: [150, 'Name cannot exceed 150 characters.'],
        default:   null,
      },
      submittedPhone: {
        type:    String,
        trim:    true,
        default: null,
      },
      submittedEmail: {
        type:    String,
        trim:    true,
        default: null,
      },
      pagePath: {
        type:    String,
        trim:    true,
        maxlength: 300,
        default: null,
        // Where the enquiry was raised: '/lien-he' or '/xe/TC-2026-0001'
      },
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

    // ── Lead Scoring (KAN-97) ─────────────────────────────────────────
    // `score` là điểm ý định 0-100 tính từ InteractionEvent. Độc lập với
    // `priority` (LOW/MEDIUM/HIGH/URGENT) do sale đặt tay — hai field khác nghĩa.
    score: {
      type: Number, default: 0, min: 0, max: SCORE_MAX, index: true,
    },
    scoreBand: {
      type:    String,
      enum:    Object.values(SCORE_BAND),
      default: SCORE_BAND.COLD,
      index:   true,
    },
    /** Tương tác mới nhất được tính vào điểm. */
    lastInteractionAt: { type: Date, default: null },
    /** Lần cuối cron chấm lại lead này. */
    lastScoredAt:      { type: Date, default: null },
    /** Số đếm event theo loại tại lần chấm gần nhất — dùng cho tooltip badge. */
    scoreFactors: {
      type: new mongoose.Schema({
        VIEW_CAR:       { type: Number, default: 0 },
        WISHLIST_ADD:   { type: Number, default: 0 },
        COMPARE_ADD:    { type: Number, default: 0 },
        CALCULATOR_USE: { type: Number, default: 0 },
        FILTER_APPLY:   { type: Number, default: 0 },
        CONTACT_CLICK:  { type: Number, default: 0 },
      }, { _id: false }),
      default: undefined,
    },

    // ── Audit ─────────────────────────────────────────────────────────
    // Null for enquiries submitted from the public website (no account).
    createdBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      default:  null,
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

// KAN-97: tối ưu GET /manage/leads/hot (sort score desc, lọc stage + active).
LeadSchema.index(
  { scoreBand: 1, stage: 1, isActive: 1, score: -1 },
  { name: 'hot_leads' },
);

const Lead = mongoose.model('Lead', LeadSchema);
export default Lead;
