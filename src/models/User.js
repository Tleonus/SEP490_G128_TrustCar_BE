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
 * Returns a safe public representation of the user (no password, no internal fields).
 * @returns {object}
 */
UserSchema.methods.toSafeObject = function () {
  const obj = this.toObject({ virtuals: true });
  delete obj.password;
  delete obj.passwordResetToken;
  delete obj.failedLoginAttempts;
  delete obj.lockedUntil;
  delete obj.tokenVersion;
  return obj;
};

const User = mongoose.model('User', UserSchema);
export default User;
