/**
 * @file Appointment.js
 * @description Test-drive, viewing, and maintenance intake scheduling model.
 *
 * Scope notes (per LI-05):
 * - AppointmentType.MAINTENANCE = intake/scheduling ONLY. No garage execution,
 *   repair work orders, or technician dispatching are tracked here.
 *
 * Key constraints:
 * - appointmentCode auto-generated (APT-NNNN) by appointmentWrite.js.
 * - scheduledAt must be ≥ 2 hours ahead and ≤ 60 days ahead (GBR-19).
 * - No overlapping CONFIRMED/PENDING appointments for the same car (GBR-20).
 * - slotSeat marks an appointment that holds a place in its time slot (older KAN-28 rows). Removing
 *   it gives the place back, and the partial unique indexes below only cover documents that have
 *   it, so newer appointments are never affected.
 * - holdsCar / visitSeat are the hold fields of the visit model: every open row holds its car, one
 *   row per visit holds the seat. They are released in the update that closes the row. Their unique
 *   indexes (appointmentHoldIndexes.js) are created by the migration script only, never here.
 * - Soft-delete only (GBR-25).
 */

import mongoose from 'mongoose';
import { AppointmentType, AppointmentStatus } from '../constants/appConstants.js';

const AppointmentSchema = new mongoose.Schema(
  {
    appointmentCode: {
      type:   String,
      unique: true,
      trim:   true,
      // Auto-generated: APT-NNNN
    },

    // ── Participants ───────────────────────────────────────────────────
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
      // The staff member responsible for this appointment
    },

    // ── Classification ─────────────────────────────────────────────────
    type: {
      type:     String,
      enum:     {
        values:  Object.values(AppointmentType),
        message: 'Appointment type must be one of: ' + Object.values(AppointmentType).join(', '),
      },
      required: [true, 'Appointment type is required.'],
    },

    // ── Scheduling ─────────────────────────────────────────────────────
    scheduledAt: {
      type:     Date,
      required: [true, 'Scheduled date/time is required.'],
      index:    true,
      // Business rules GBR-19 and GBR-20 enforced in service layer
    },

    durationMinutes: {
      type:    Number,
      default: 60,
      min:     15,
      max:     480,
    },

    location: {
      type:      String,
      trim:      true,
      maxlength: 300,
      default:   null,
      // e.g., 'Showroom – 123 Lê Lợi, Q1, HCM'
    },

    // ── Status ─────────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    {
        values:  Object.values(AppointmentStatus),
        message: 'Status must be one of: ' + Object.values(AppointmentStatus).join(', '),
      },
      default: AppointmentStatus.PENDING,
      index:   true,
    },

    // ── Notes & Outcome ────────────────────────────────────────────────
    notes: {
      type:      String,
      trim:      true,
      maxlength: [2000, 'Notes cannot exceed 2000 characters.'],
      default:   null,
    },

    cancellationReason: {
      type:      String,
      trim:      true,
      maxlength: 500,
      default:   null,
      // Populated when status = CANCELLED
    },

    completedAt: {
      type:    Date,
      default: null,
    },

    // ── Test-Drive Slot & Reminder ─────────────────────────────────────
    slotSeat: {
      type: Number,
      min:  1,
      // Present only while PENDING/CONFIRMED; 1…maxGuestsPerSlot within the slot
    },

    // ── Visit holds (test-drive-capacity-guard) ────────────────────────
    // Present only while the row is open (PENDING/CONFIRMED, isActive). Both are $unset in the
    // same update that closes the row. The unique indexes that use them are NOT declared here:
    // see appointmentHoldIndexes.js (created only by the migration script).
    holdsCar: {
      type: Boolean,
      // true on every open row: one open row per (car, scheduledAt)
    },

    visitSeat: {
      type: Number,
      min:  1,
      // Only on ONE row of a visit (lowest appointmentCode): the visit's seat in its slot
    },

    reminderSentAt: {
      type: Date,
      // Set before sending so that overlapping scans cannot send twice; cleared on failure
    },

    outcome: {
      type:      String,
      trim:      true,
      maxlength: 1000,
      default:   null,
      // Outcome notes recorded after completion
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

    confirmedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },

    confirmedAt: {
      type:    Date,
      default: null,
    },
  },
  {
    timestamps:  true,
    versionKey:  false,
    collection:  'appointments',
  }
);

// ── Indexes ────────────────────────────────────────────────────────────────
AppointmentSchema.index({ car: 1, scheduledAt: 1, status: 1 }); // Conflict detection (GBR-20)
AppointmentSchema.index({ customer: 1 });
AppointmentSchema.index({ assignedTo: 1 });
AppointmentSchema.index({ status: 1, scheduledAt: 1 });
AppointmentSchema.index({ appointmentCode: 1 });

// Concurrent bookings: the database refuses a second holder of the same car, staff
// member or seat at the same time, whichever request got there first.
const HOLDS_A_SEAT = { partialFilterExpression: { slotSeat: { $type: 'number' } }, unique: true };
AppointmentSchema.index({ car: 1, scheduledAt: 1 }, { ...HOLDS_A_SEAT, name: 'uniq_seat_car_time' });
AppointmentSchema.index({ assignedTo: 1, scheduledAt: 1 }, { ...HOLDS_A_SEAT, name: 'uniq_seat_staff_time' });
AppointmentSchema.index({ scheduledAt: 1, slotSeat: 1 }, { ...HOLDS_A_SEAT, name: 'uniq_seat_number_time' });

const Appointment = mongoose.model('Appointment', AppointmentSchema);
export default Appointment;
