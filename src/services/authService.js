/**
 * @file authService.js
 * @description Authentication business logic for the TrustCar platform.
 *
 * Responsibilities:
 * - Login with brute-force protection (GBR-12)
 * - JWT access + refresh token generation
 * - Password change and reset flow
 * - Activity logging for all auth events (GBR-24)
 *
 * This layer contains ZERO Express req/res references.
 * All database interactions go through Mongoose models directly
 * (no separate Repository class – the model IS the DAL in this architecture).
 */

import jwt from 'jsonwebtoken';
import dayjs from 'dayjs';
import User from '../models/User.js';
import ActivityLog from '../models/ActivityLog.js';
import { generateCryptoToken } from '../utils/codeGenerator.js';
import { sendMail } from '../config/mailer.js';
import { AppError } from '../utils/apiResponse.js';
import { AUTH_LOCK, ActivityEventType } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';

// ════════════════════════════════════════════════════════════════════════════
// TOKEN GENERATION HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generates a signed JWT access token.
 * @param {object} payload - { userId, email, roleName }
 * @returns {string} Signed JWT.
 */
const generateAccessToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    issuer:    'TrustCar',
    audience:  'TrustCar-Client',
  });
};

/**
 * Generates a signed JWT refresh token.
 * @param {object} payload - { userId }
 * @returns {string} Signed JWT.
 */
const generateRefreshToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    issuer:    'TrustCar',
    audience:  'TrustCar-Client',
  });
};

/**
 * Builds the token payload from a User document.
 * @param {object} user - Mongoose User document.
 * @returns {{ userId, email, roleName }}
 */
const buildTokenPayload = (user) => ({
  userId:   user._id.toString(),
  email:    user.email,
  roleName: user.roleName,
});

// ════════════════════════════════════════════════════════════════════════════
// AUTH SERVICE METHODS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Authenticates a user by email and password.
 * Enforces brute-force lock (GBR-12) and logs the event (GBR-24).
 *
 * @param {object} params
 * @param {string} params.email
 * @param {string} params.password
 * @param {string} [params.ipAddress]
 * @param {string} [params.userAgent]
 * @returns {Promise<{ user: object, accessToken: string, refreshToken: string }>}
 * @throws {AppError}
 */
export const login = async ({ email, password, ipAddress, userAgent }) => {
  // Find user with password field (excluded by default)
  const user = await User.findOne({ email: email.toLowerCase() })
    .select('+password +failedLoginAttempts +lockedUntil +passwordResetToken')
    .populate('role');

  // ── Unknown email → generic error (security: don't reveal email existence)
  if (!user) {
    throw new AppError(MSG.MSG07.message, MSG.MSG07.httpStatus, MSG.MSG07.code);
  }

  // ── Account deactivated (GBR-21)
  if (!user.isActive) {
    throw new AppError(MSG.MSG06.message, MSG.MSG06.httpStatus, MSG.MSG06.code);
  }

  // ── Account locked check (GBR-12)
  if (user.isLocked) {
    const unlocksAt = dayjs(user.lockedUntil).format('HH:mm DD/MM/YYYY');
    await ActivityLog.log({
      eventType: ActivityEventType.LOGIN_FAILED,
      performedBy: user._id,
      performedByEmail: user.email,
<<<<<<< Updated upstream
      targetModel:      'User',
      targetId:         user._id,
      summary:          `Login blocked – account locked until ${unlocksAt}`,
=======
      targetModel: 'User',
      targetId: user._id,
      summary: 'Failed login attempt (wrong password)',
>>>>>>> Stashed changes
      ipAddress,
      userAgent,
    });
    throw new AppError(MSG.MSG10.message, MSG.MSG10.httpStatus, MSG.MSG10.code);
  }

  // ── Wrong password
  const isPasswordCorrect = await user.comparePassword(password);
  if (!isPasswordCorrect) {
    await user.incrementFailedAttempts(); // GBR-12

    const remaining = AUTH_LOCK.MAX_FAILED_ATTEMPTS - user.failedLoginAttempts;
    const isNowLocked = user.isLocked;

    // Write audit log
    await ActivityLog.log({
      eventType:        ActivityEventType.LOGIN_FAILED,
      performedBy:      user._id,
      performedByEmail: user.email,
      targetModel:      'User',
      targetId:         user._id,
      summary:          isNowLocked
        ? `Account locked after ${AUTH_LOCK.MAX_FAILED_ATTEMPTS} failed attempts`
        : `Failed login attempt (${user.failedLoginAttempts}/${AUTH_LOCK.MAX_FAILED_ATTEMPTS})`,
      ipAddress,
      userAgent,
    });

    if (isNowLocked) {
      throw new AppError(MSG.MSG10.message, MSG.MSG10.httpStatus, MSG.MSG10.code);
    }

    throw new AppError(
      MSG.MSG11.message.replace('{remaining}', Math.max(0, remaining)),
      MSG.MSG11.httpStatus,
      MSG.MSG11.code
    );
  }

  // ── SUCCESS: Reset failed attempts & update last login (GBR-12)
  await user.resetFailedAttempts();

  user.lastLoginAt = new Date();
  user.lastLoginIp = ipAddress || null;
  await user.save({ validateBeforeSave: false });

<<<<<<< Updated upstream
  // ── Generate tokens
  const payload      = buildTokenPayload(user);
  const accessToken  = generateAccessToken(payload);
  const refreshToken = generateRefreshToken({ userId: user._id.toString() });
=======
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
>>>>>>> Stashed changes

  // ── Audit log: successful login (GBR-24)
  await ActivityLog.log({
    eventType: ActivityEventType.USER_LOGIN,
    performedBy: user._id,
    performedByEmail: user.email,
    targetModel: 'User',
    targetId: user._id,
    summary: `Successful login from ${ipAddress || 'unknown IP'}`,
    ipAddress,
    userAgent,
  });

  return {
    user:         user.toSafeObject(),
    accessToken,
    refreshToken,
  };
};

/**
 * Refreshes the access token using a valid refresh token.
 * @param {string} refreshToken
 * @returns {Promise<{ accessToken: string }>}
 * @throws {AppError}
 */
export const refreshAccessToken = async (refreshToken) => {
  if (!refreshToken) {
    throw new AppError(MSG.MSG15.message, MSG.MSG15.httpStatus, MSG.MSG15.code);
  }

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
  } catch {
    throw new AppError(MSG.MSG15.message, MSG.MSG15.httpStatus, MSG.MSG15.code);
  }

  const user = await User.findById(decoded.userId).populate('role');
  if (!user || !user.isActive) {
    throw new AppError(MSG.MSG15.message, MSG.MSG15.httpStatus, MSG.MSG15.code);
  }

  const newAccessToken = generateAccessToken(buildTokenPayload(user));
  return { accessToken: newAccessToken };
};

/**
<<<<<<< Updated upstream
 * Changes the authenticated user's own password.
=======
 * Logs the user out of every device by bumping tokenVersion, which makes all
 * previously issued access and refresh tokens fail verification.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.email]
 * @param {string} [params.ipAddress]
 * @param {string} [params.userAgent]
 * @returns {Promise<void>}
 */
export const logout = async ({ userId, email, ipAddress, userAgent }) => {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });

  await ActivityLog.log({
    eventType: ActivityEventType.USER_LOGOUT,
    performedBy: userId,
    performedByEmail: email,
    targetModel: 'User',
    targetId: userId,
    summary: 'User logged out (all sessions revoked)',
    ipAddress,
    userAgent,
  });
};

/**
 * Changes the authenticated user's own password and revokes all of their sessions.
>>>>>>> Stashed changes
 * Ref: GBR-22, GBR-23
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.currentPassword
 * @param {string} params.newPassword
 * @param {string} [params.ipAddress]
 * @returns {Promise<void>}
 */
export const changePassword = async ({ userId, currentPassword, newPassword, ipAddress }) => {
  const user = await User.findById(userId).select('+password');
  if (!user) throw new AppError(MSG.MSG17.message, 404, MSG.MSG17.code);

  const isCurrentCorrect = await user.comparePassword(currentPassword);
  if (!isCurrentCorrect) {
    throw new AppError('Current password is incorrect.', 401, 'CURRENT_PASSWORD_WRONG');
  }

  const isSamePassword = await user.comparePassword(newPassword);
  if (isSamePassword) {
    throw new AppError(MSG.MSG13.message, 422, MSG.MSG13.code);
  }

  user.password = newPassword; // Pre-save hook will hash this
<<<<<<< Updated upstream
=======
  user.tokenVersion = (user.tokenVersion ?? 0) + 1; // revoke every session, including this one
>>>>>>> Stashed changes
  await user.save();

  await ActivityLog.log({
    eventType: ActivityEventType.PASSWORD_CHANGED,
    performedBy: user._id,
    performedByEmail: user.email,
    targetModel: 'User',
    targetId: user._id,
    summary: 'User changed their own password',
    ipAddress,
  });
};

/**
 * Initiates a password reset by generating a token and sending an email.
 * @param {string} email
 * @returns {Promise<void>}
 */
export const forgotPassword = async (email) => {
  const user = await User.findOne({ email: email.toLowerCase(), isActive: true });
  // Security: do not reveal whether email exists – always succeed silently
  if (!user) return;

  const resetToken = await generateCryptoToken(32);
  const expiresAt = dayjs().add(1, 'hour').toDate();

  user.passwordResetToken = { token: resetToken, expiresAt };
  await user.save({ validateBeforeSave: false });

  const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`;

<<<<<<< Updated upstream
  await sendMail({
    to:      user.email,
    toName:  user.fullName,
    subject: 'TrustCar – Password Reset Request',
    html: `
      <h2>Password Reset</h2>
      <p>Hello ${user.fullName},</p>
      <p>You requested a password reset. Click the link below to set a new password:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>This link expires in <strong>1 hour</strong>.</p>
      <p>If you did not request this, please ignore this email.</p>
    `,
  });
=======
  // A delivery failure must not change the response (it would reveal that the
  // email is registered); log it server-side without the reset link.
  try {
    await sendMail({
      to: user.email,
      toName: user.fullName,
      subject: 'TrustCar – Password Reset Request',
      html: `
        <h2>Password Reset</h2>
        <p>Hello ${escapeHtml(user.fullName)},</p>
        <p>You requested a password reset. Click the link below to set a new password:</p>
        <p><a href="${resetUrl}">${resetUrl}</a></p>
        <p>This link expires in <strong>1 hour</strong>.</p>
        <p>If you did not request this, please ignore this email.</p>
      `,
    });
  } catch (error) {
    logger.error(`Password reset email failed for user ${user._id}: ${error.message}`);
    return;
  }
>>>>>>> Stashed changes

  await ActivityLog.log({
    eventType: ActivityEventType.PASSWORD_RESET,
    performedBy: user._id,
    performedByEmail: user.email,
    targetModel: 'User',
    targetId: user._id,
    summary: 'Password reset email dispatched',
  });
};

/**
 * Resets a user's password using the reset token.
 * @param {object} params
 * @param {string} params.token
 * @param {string} params.newPassword
 * @returns {Promise<void>}
 */
export const resetPassword = async ({ token, newPassword }) => {
<<<<<<< Updated upstream
  const user = await User.findOne({
    'passwordResetToken.token':     token,
=======
  const invalidLink = () => new AppError(MSG.MSG14.message, MSG.MSG14.httpStatus, MSG.MSG14.code);
  const validLinkFilter = () => ({
    'passwordResetToken.token': token,
>>>>>>> Stashed changes
    'passwordResetToken.expiresAt': { $gt: new Date() },
    isActive: true,
  }).select('+passwordResetToken +password');

  if (!user) {
    throw new AppError(MSG.MSG14.message, 400, MSG.MSG14.code);
  }

<<<<<<< Updated upstream
  user.password           = newPassword;
  user.passwordResetToken = undefined;
  user.failedLoginAttempts = 0;
  user.lockedUntil        = null;
  await user.save();
=======
  const hashedPassword = await User.hashPassword(newPassword);

  // The same condition is re-applied atomically: a concurrent request may have
  // consumed the link between the pre-check and this update.
  const user = await User.findOneAndUpdate(
    validLinkFilter(),
    {
      $set: { password: hashedPassword },
      $unset: { passwordResetToken: 1 },
      $inc: { tokenVersion: 1 },
    },
    { new: true }
  );

  if (!user) throw invalidLink();
>>>>>>> Stashed changes

  await ActivityLog.log({
    eventType: ActivityEventType.PASSWORD_RESET,
    performedBy: user._id,
    performedByEmail: user.email,
    targetModel: 'User',
    targetId: user._id,
    summary: 'Password successfully reset via token',
  });
};

/**
 * Returns the full profile of the currently authenticated user.
 * @param {string} userId
 * @returns {Promise<object>}
 */
export const getMyProfile = async (userId) => {
  const user = await User.findById(userId)
    .populate('role', 'name permissions')
    .lean();

  if (!user) throw new AppError(MSG.MSG17.message, 404, MSG.MSG17.code);
  return user;
};

export default {
  login,
  refreshAccessToken,
  changePassword,
  forgotPassword,
  resetPassword,
  getMyProfile,
};
