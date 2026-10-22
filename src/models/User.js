/**
 * @file User.js
 * @description Internal staff and admin account model for the TrustCar platform.
 *
 * Key features:
 * - Password hashing via bcryptjs pre-save hook.
 * - Failed login attempt tracking and account lock (GBR-12).
 * - Active session enforcement via isActive flag (GBR-21).
 * - Role reference for RBAC (GBR-02).
 * - Virtual `isLocked` computed from lockedUntil.
 * - comparePassword instance method for authentication.
 * - Password field excluded from all queries by default (select: false).
 */

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { Roles, AUTH_LOCK } from '../constants/appConstants.js';

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
      required:  [true, 'Full name is required.'],
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
      required: [true, 'Password is required.'],
      minlength: 8,
      select:   false, // Never returned in queries unless explicitly .select('+password')
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

    // ── Brute-Force Protection (GBR-12) ───────────────────────────────────
    failedLoginAttempts: {
      type:    Number,
      default: 0,
      min:     0,
      max:     AUTH_LOCK.MAX_FAILED_ATTEMPTS + 5, // Slight buffer for edge cases
    },

    lockedUntil: {
      type:    Date,
      default: null,
      // When non-null and in the future, the account is locked (GBR-12)
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
  if (!this.isModified('password')) return next();
  try {
    const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 12;
    this.password = await bcrypt.hash(this.password, saltRounds);
    next();
  } catch (err) {
    next(err);
  }
});

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
 * Increments failed login attempts and locks the account if threshold reached.
 * Ref: GBR-12
 * @returns {Promise<void>}
 */
UserSchema.methods.incrementFailedAttempts = async function () {
  this.failedLoginAttempts += 1;

  if (this.failedLoginAttempts >= AUTH_LOCK.MAX_FAILED_ATTEMPTS) {
    this.lockedUntil = new Date(Date.now() + AUTH_LOCK.LOCK_DURATION_MINUTES * 60 * 1000);
  }

  await this.save({ validateBeforeSave: false });
};

/**
 * Resets brute-force counters after a successful login.
 * Ref: GBR-12
 * @returns {Promise<void>}
 */
UserSchema.methods.resetFailedAttempts = async function () {
  if (this.failedLoginAttempts !== 0 || this.lockedUntil !== null) {
    this.failedLoginAttempts = 0;
    this.lockedUntil         = null;
    await this.save({ validateBeforeSave: false });
  }
};

/**
 * Returns a safe public representation of the user (no password, no internal fields).
 * @returns {object}
 */
UserSchema.methods.toSafeObject = function () {
  const obj = this.toObject({ virtuals: true });
  delete obj.password;
  delete obj.passwordResetToken;
  delete obj.failedLoginAttempts;
  delete obj.lockedUntil;
  return obj;
};

const User = mongoose.model('User', UserSchema);
export default User;
