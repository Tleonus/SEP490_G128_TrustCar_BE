/**
 * @file Customer.js
 * @description External customer (contact) model – individuals who inquire about or
 * purchase vehicles at the showroom. Not to be confused with internal User accounts.
 *
 * Key constraints:
 * - Phone number is normalized to 10-digit Vietnamese format before persistence (GBR-16).
 * - Soft-delete only via isActive=false (GBR-25).
 */

import mongoose from 'mongoose';

const CustomerSchema = new mongoose.Schema(
  {
    // ── Identity ────────────────────────────────────────────────────────
    fullName: {
      type:      String,
      required:  [true, 'Customer full name is required.'],
      trim:      true,
      maxlength: [150, 'Full name cannot exceed 150 characters.'],
    },

    // ── Contact Information ─────────────────────────────────────────────
    phone: {
      type:     String,
      required: [true, 'Phone number is required.'],
      trim:     true,
      match:    [/^0[3-9][0-9]{8}$/, 'Phone must be a valid 10-digit Vietnamese number (normalized).'],
      // Normalization (+84 → 0) performed in customerService.js BEFORE save (GBR-16)
      index:    true,
    },

    email: {
      type:      String,
      lowercase: true,
      trim:      true,
      default:   null,
      match:     [/^\S+@\S+\.\S+$/, 'Invalid email format.'],
    },

    // ── Address ─────────────────────────────────────────────────────────
    address: {
      street:   { type: String, trim: true, default: null },
      district: { type: String, trim: true, default: null },
      city:     { type: String, trim: true, default: null },
      province: { type: String, trim: true, default: null },
    },

    // ── Demographics / CRM Metadata ─────────────────────────────────────
    dateOfBirth: {
      type:    Date,
      default: null,
    },

    gender: {
      type:    String,
      enum:    ['MALE', 'FEMALE', 'OTHER', null],
      default: null,
    },

    source: {
      type:    String,
      trim:    true,
      default: null,
      // e.g., 'Walk-in', 'Facebook', 'Referral', 'Website'
    },
    marketingConsent: {
      type: Boolean,
      default: false,
    },

    notes: {
      type:      String,
      trim:      true,
      maxlength: [2000, 'Notes cannot exceed 2000 characters.'],
      default:   null,
    },

    // ── Status ──────────────────────────────────────────────────────────
    isActive: {
      type:    Boolean,
      default: true,
    },

    // ── Audit ────────────────────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'User',
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
    collection:  'customers',
  }
);

// ── Indexes ────────────────────────────────────────────────────────────────
CustomerSchema.index({ phone: 1 });
CustomerSchema.index({ email: 1 });
CustomerSchema.index({ fullName: 'text' }); // Text search
CustomerSchema.index({ isActive: 1 });

const Customer = mongoose.model('Customer', CustomerSchema);
export default Customer;
