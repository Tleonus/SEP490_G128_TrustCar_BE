/**
 * @file ActivityLog.js
 * @description Immutable audit trail for all operational actions on the TrustCar platform.
 *
 * Design decisions:
 * - NO updatedAt timestamp – this collection is write-once (append-only).
 * - All services must write an ActivityLog entry for every create/update/status-change.
 * - This collection is never hard-deleted or modified via any API endpoint (GBR-24).
 * - Mongoose's timestamps option is DISABLED and only createdAt is set manually
 *   to reinforce immutability intent.
 *
 * Ref: GBR-24
 */

import mongoose from 'mongoose';
import { ActivityEventType } from '../constants/appConstants.js';

// ── Change Snapshot Subdocument ────────────────────────────────────────────
const ChangeSnapshotSchema = new mongoose.Schema(
  {
    before: { type: mongoose.Schema.Types.Mixed, default: null }, // State before change
    after:  { type: mongoose.Schema.Types.Mixed, default: null }, // State after change
  },
  { _id: false }
);

// ── Main ActivityLog Schema ────────────────────────────────────────────────
const ActivityLogSchema = new mongoose.Schema(
  {
    // ── Event Classification ───────────────────────────────────────────
    eventType: {
      type:     String,
      required: [true, 'Event type is required.'],
      enum:     {
        values:  Object.values(ActivityEventType),
        message: 'Invalid event type.',
      },
      index:    true,
    },

    // ── Actor ──────────────────────────────────────────────────────────
    performedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
      // null = system-initiated action (e.g., scheduled job, seed script)
      index:   true,
    },

    performedByEmail: {
      type:    String,
      default: null,
      // Denormalized snapshot – preserves actor identity even if user is deleted
    },

    // ── Target Resource ────────────────────────────────────────────────
    targetModel: {
      type:    String,
      default: null,
      // e.g., 'Car', 'User', 'Lead', 'Appointment'
    },

    targetId: {
      type:    mongoose.Schema.Types.ObjectId,
      default: null,
      index:   true,
      // The _id of the affected document
    },

    targetCode: {
      type:    String,
      default: null,
      // Human-readable code (e.g., 'TC-2024-0001', 'LD-0042') for quick log reading
    },

    // ── Change Detail ──────────────────────────────────────────────────
    changes: {
      type:    ChangeSnapshotSchema,
      default: null,
    },

    // ── Summary Message ────────────────────────────────────────────────
    summary: {
      type:      String,
      trim:      true,
      maxlength: 500,
      default:   null,
      // Human-readable one-liner: e.g., 'Status changed from AVAILABLE to RESERVED'
    },

    // ── Request Context ────────────────────────────────────────────────
    ipAddress: {
      type:    String,
      default: null,
    },

    userAgent: {
      type:    String,
      default: null,
    },

    // ── Additional Metadata ───────────────────────────────────────────
    metadata: {
      type:    mongoose.Schema.Types.Mixed,
      default: null,
      // Any additional context: { reason, previousStage, newStage, etc. }
    },

    // ── Timestamp (immutable – NOT using Mongoose timestamps) ─────────
    createdAt: {
      type:     Date,
      default:  () => new Date(),
      immutable: true, // Mongoose 7+ feature
    },
  },
  {
    // Deliberately disable Mongoose auto-timestamps to prevent an `updatedAt` field
    timestamps: false,
    versionKey: false,
    collection: 'activity_logs',
  }
);

// ── Indexes ────────────────────────────────────────────────────────────────
ActivityLogSchema.index({ createdAt: -1 });                      // Time-based querying
ActivityLogSchema.index({ performedBy: 1, createdAt: -1 });      // User activity history
ActivityLogSchema.index({ targetModel: 1, targetId: 1 });        // Resource audit trail
ActivityLogSchema.index({ eventType: 1, createdAt: -1 });        // Event type filtering

// ── Enforce Immutability ──────────────────────────────────────────────────
// Prevent any update operations from succeeding on this model
ActivityLogSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
  throw new Error('ActivityLog is immutable. Updates are not permitted (GBR-24).');
});

// ── Static Helper ─────────────────────────────────────────────────────────
/**
 * Creates an audit log entry. Called from all service functions.
 * Fails silently in development if log write fails to prevent blocking
 * the primary operation; throws in production per GBR-24.
 *
 * @param {object} logData
 * @returns {Promise<void>}
 */
ActivityLogSchema.statics.log = async function (logData) {
  try {
    await this.create(logData);
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      // In production, audit log failure should surface
      throw error;
    }
    console.error('⚠️  ActivityLog write failed (non-fatal in dev):', error.message);
  }
};

const ActivityLog = mongoose.model('ActivityLog', ActivityLogSchema);
export default ActivityLog;
