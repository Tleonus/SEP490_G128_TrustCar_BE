/**
 * @file User.js
 * @description Internal staff and admin account model for the TrustCar platform.
 *
 * Key features:
 * - Password hashing via bcryptjs pre-save hook.
 * - Legacy lock fields (failedLoginAttempts, lockedUntil) kept for existing data;
 *   login no longer locks accounts (GBR-12 retired 2026-10-24).
 * - tokenVersion counter for revoking all sessions of a user.
 * - Active session enforcement via isActive flag (GBR-21).
 * - Role reference for RBAC (GBR-02).
 * - Virtual `isLocked` computed from lockedUntil.
 * - comparePassword instance method for authentication.
 * - Password field excluded from all queries by default (select: false).
 */

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { Roles } from '../constants/appConstants.js';

// ── Subdocument: Password Reset Token ─────────────────────────────────────
const PasswordResetSchema = new mongoose.Schema(
  {
    token:     { type: String, required: true },
    expiresAt: { type: Date,   required: true },
  },
  { _id: false }
);

// ── Main User Schema ──────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema(
  {
    // ── Identity ────────────────────────────────────────────────────────
    fullName: {
      type:      String,
      // Customers created through Google may start without a name and fill it
      // in when completing their profile (see profileStatus).
      required:  [function () { return this.roleName !== Roles.CUSTOMER; }, 'Full name is required.'],
      trim:      true,
      maxlength: [100, 'Full name cannot exceed 100 characters.'],
    },

    email: {
      type:      String,
      required:  [true, 'Email address is required.'],
      unique:    true,
      lowercase: true,
      trim:      true,
      match:     [/^\S+@\S+\.\S+$/, 'Please provide a valid email address.'],
    },

    phone: {
      type:   String,
      trim:   true,
      match:  [/^0[3-9][0-9]{8}$/, 'Phone number must be a valid 10-digit Vietnamese number.'],
    },

    avatar: {
      url:      { type: String, default: null },
      publicId: { type: String, default: null },
    },

    // ── Authentication ───────────────────────────────────────────────────
    password: {
      type:     String,
      // Only a customer account linked to Google may exist without a password
      // (until the profile is completed). When firebaseUid was not loaded we
      // cannot tell, so the rule is not applied.
      required: [
        function () {
          if (this.roleName !== Roles.CUSTOMER) return true;
          return this.isSelected('firebaseUid') && !this.firebaseUid;
        },
        'Password is required.',
      ],
      minlength: 8,
      select:   false, // Never returned in queries unless explicitly .select('+password')
    },

    // Firebase Authentication UID of the linked Google identity (customers only).
    firebaseUid: {
      type:   String,
      select: false,
    },

    // Customer (showroom profile) this customer account is linked to.
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'Customer',
    },

    passwordResetToken: {
      type:   PasswordResetSchema,
      select: false,
    },

    // ── Role & Status ────────────────────────────────────────────────────
    role: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Role',
      required: [true, 'User role is required.'],
    },

    roleName: {
      type:  String,
      enum:  Object.values(Roles),
      // Denormalized for fast JWT payload construction without an extra lookup
    },

    isActive: {
      type:    Boolean,
      default: true,
      index:   true,
    },

    // ── Legacy Brute-Force Fields (GBR-12, retired) ───────────────────────
    // No longer written by login; kept so existing documents stay valid and
    // admin reactivation can still clear them.
    failedLoginAttempts: {
      type:    Number,
      default: 0,
      min:     0,
      max:     10,
    },

    lockedUntil: {
      type:    Date,
      default: null,
    },

    // ── Session Revocation ────────────────────────────────────────────────
    // Monotonic counter embedded in every issued JWT. Bumping it on logout /
    // password change / password reset invalidates all previously issued
    // tokens on every device.
    tokenVersion: {
      type:    Number,
      default: 0,
      min:     0,
      select:  false,
    },

    // ── Session Metadata ──────────────────────────────────────────────────
    lastLoginAt: {
      type:    Date,
      default: null,
    },

    lastLoginIp: {
      type:    String,
      default: null,
    },

    // ── Audit ─────────────────────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'User',
      default: null, // null = seeded by system
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'User',
      default: null,
    },
  },
  {
    timestamps:  true,
    versionKey:  false,
    collection:  'users',
  }
);

// ── Indexes ────────────────────────────────────────────────────────────────
UserSchema.index({ email: 1 });
UserSchema.index({ roleName: 1 });
UserSchema.index({ isActive: 1 });
UserSchema.index(
  { firebaseUid: 1 },
  { unique: true, partialFilterExpression: { firebaseUid: { $type: 'string' } } }
);
UserSchema.index(
  { customer: 1 },
  { unique: true, partialFilterExpression: { customer: { $type: 'objectId' } } }
);
// One phone number per customer account (staff phones are not constrained).
UserSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { roleName: Roles.CUSTOMER, phone: { $type: 'string' } } }
);

// ── Virtuals ───────────────────────────────────────────────────────────────
/**
 * Returns true if the account is currently locked due to brute-force protection.
 * Ref: GBR-12
 */
UserSchema.virtual('isLocked').get(function () {
  return this.lockedUntil !== null && this.lockedUntil > new Date();
});

// ── Pre-Save Hook: Password Hashing ───────────────────────────────────────
/**
 * Automatically hashes the password field whenever it is modified.
 * Uses bcryptjs with BCRYPT_SALT_ROUNDS env variable (default 12).
 */
UserSchema.pre('save', async function (next) {
  // Google-only customers have no password yet – nothing to hash.
  if (!this.isModified('password') || !this.password) return next();
  try {
    this.password = await this.constructor.hashPassword(this.password);
    next();
  } catch (err) {
    next(err);
  }
});

// ── Static Methods ─────────────────────────────────────────────────────────

/**
 * Hashes a plaintext password with bcrypt. Shared by the pre-save hook and by
 * flows that write the password through an atomic update (which bypasses hooks).
 * @param {string} plainPassword
 * @returns {Promise<string>}
 */
UserSchema.statics.hashPassword = async function (plainPassword) {
  const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 12;
  return bcrypt.hash(plainPassword, saltRounds);
};

// ── Instance Methods ───────────────────────────────────────────────────────

/**
 * Compares a plaintext password against the stored hash.
 * @param {string} candidatePassword - Plaintext password from login request.
 * @returns {Promise<boolean>}
 */
UserSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

/**
 * Profile completeness of an account (document or lean object).
 * Staff accounts are always complete; a customer is complete once it has a
 * full name, a phone number and a password. The password must have been
 * loaded (select '+password') for the result to be accurate.
 *
 * @param {object} user
 * @returns {{ profileCompleted: boolean, missingFields: string[] }}
 */
UserSchema.statics.getProfileStatus = function (user) {
  if (user.roleName !== Roles.CUSTOMER) return { profileCompleted: true, missingFields: [] };
  const missingFields = [];
  if (!user.fullName) missingFields.push('fullName');
  if (!user.phone) missingFields.push('phone');
  if (!user.password) missingFields.push('password');
  return { profileCompleted: missingFields.length === 0, missingFields };
};

/** Profile completeness of this document (load '+password' first). */
UserSchema.methods.profileStatus = function () {
  return this.constructor.getProfileStatus(this);
};

/**
 * Returns a safe public representation of the user (no password, no internal fields),
 * including its profile completeness. Load '+password' first for an accurate status.
 * @returns {object}
 */
UserSchema.methods.toSafeObject = function () {
  const obj = this.toObject({ virtuals: true });
  Object.assign(obj, this.profileStatus());
  delete obj.password;
  delete obj.passwordResetToken;
  delete obj.failedLoginAttempts;
  delete obj.lockedUntil;
  delete obj.tokenVersion;
  delete obj.firebaseUid;
  return obj;
};

const User = mongoose.model('User', UserSchema);
export default User;
