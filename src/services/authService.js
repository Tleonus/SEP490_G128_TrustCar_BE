/**
 * @file authService.js
 * @description Authentication business logic for the TrustCar platform.
 *
 * Responsibilities:
 * - Login (no account lock; GBR-12 retired – brute force is rate-limited per IP)
 * - JWT access + refresh tokens with type and tokenVersion claims (authTokens.js)
 * - Logout / password change / password reset revoke every session (tokenVersion)
 * - Activity logging for all auth events (GBR-24)
 *
 * This layer contains ZERO Express req/res references.
 * All database interactions go through Mongoose models directly
 * (no separate Repository class – the model IS the DAL in this architecture).
 */

import dayjs from 'dayjs';
import User from '../models/User.js';
import ActivityLog from '../models/ActivityLog.js';
import { generateCryptoToken } from '../utils/codeGenerator.js';
import logger from '../utils/logger.js';
import { sendMail } from '../config/mailer.js';
import { emailButton, frontendUrl } from '../utils/emailLayout.js';
import { AppError } from '../utils/apiResponse.js';
import { ActivityEventType } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import {
  TokenType,
  signAccessToken,
  signRefreshToken,
  verifyTokenOfType,
  isTokenCurrent,
} from '../utils/authTokens.js';

const invalidCredentials = () =>
  new AppError(MSG.MSG07.message, MSG.MSG07.httpStatus, MSG.MSG07.code);

/** Escapes user-controlled text before it is placed into an HTML email body. */
const escapeHtml = (value = '') =>
  String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));

// ════════════════════════════════════════════════════════════════════════════
// AUTH SERVICE METHODS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Authenticates a user by email and password.
 * The password is checked BEFORE the account status so a wrong password never
 * reveals whether an account exists or is deactivated. Logs the event (GBR-24).
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
  const user = await User.findOne({ email: email.toLowerCase() })
    .select('+password +tokenVersion')
    .populate('role');

  // ── Unknown email → generic error, nothing to audit against
  if (!user) throw invalidCredentials();

  // ── Wrong password, or account without a password (Google-only) → generic error (no lock)
  const isPasswordCorrect = Boolean(user.password) && await user.comparePassword(password);
  if (!isPasswordCorrect) {
    await ActivityLog.log({
      eventType:        ActivityEventType.LOGIN_FAILED,
      performedBy:      user._id,
      performedByEmail: user.email,
      targetModel:      'User',
      targetId:         user._id,
      summary:          'Failed login attempt (wrong password)',
      ipAddress,
      userAgent,
    });
    throw invalidCredentials();
  }

  // ── Correct password but account deactivated (GBR-21)
  if (!user.isActive) {
    throw new AppError(MSG.MSG06.message, MSG.MSG06.httpStatus, MSG.MSG06.code);
  }

  user.lastLoginAt = new Date();
  user.lastLoginIp = ipAddress || null;
  await user.save({ validateBeforeSave: false });

  const accessToken  = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  await ActivityLog.log({
    eventType:        ActivityEventType.USER_LOGIN,
    performedBy:      user._id,
    performedByEmail: user.email,
    targetModel:      'User',
    targetId:         user._id,
    summary:          `Successful login from ${ipAddress || 'unknown IP'}`,
    ipAddress,
    userAgent,
  });

  return {
    user: user.toSafeObject(),
    accessToken,
    refreshToken,
  };
};

/**
 * Issues a new access token from a refresh token that is valid, of type
 * `refresh`, not revoked (tokenVersion matches) and belongs to an active user.
 * @param {string} refreshToken
 * @returns {Promise<{ accessToken: string }>}
 * @throws {AppError} MSG15 for every failure reason.
 */
export const refreshAccessToken = async (refreshToken) => {
  const invalidRefresh = () =>
    new AppError(MSG.MSG15.message, MSG.MSG15.httpStatus, MSG.MSG15.code);

  if (!refreshToken) throw invalidRefresh();

  let decoded;
  try {
    decoded = verifyTokenOfType(refreshToken, TokenType.REFRESH);
  } catch {
    throw invalidRefresh();
  }

  const user = await User.findById(decoded.userId).select('+tokenVersion');
  if (!user || !user.isActive || !isTokenCurrent(decoded, user)) {
    throw invalidRefresh();
  }

  return { accessToken: signAccessToken(user) };
};

/**
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
    eventType:        ActivityEventType.USER_LOGOUT,
    performedBy:      userId,
    performedByEmail: email,
    targetModel:      'User',
    targetId:         userId,
    summary:          'User logged out (all sessions revoked)',
    ipAddress,
    userAgent,
  });
};

/**
 * Changes the authenticated user's own password and revokes all of their sessions.
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
  const user = await User.findById(userId).select('+password +tokenVersion');
  if (!user) throw new AppError(MSG.MSG17.message, 404, MSG.MSG17.code);

  // 400 (not 401): a wrong current password must not look like an expired session to clients
  const isCurrentCorrect = await user.comparePassword(currentPassword);
  if (!isCurrentCorrect) {
    throw new AppError('Current password is incorrect.', 400, 'CURRENT_PASSWORD_WRONG');
  }

  const isSamePassword = await user.comparePassword(newPassword);
  if (isSamePassword) {
    throw new AppError(MSG.MSG13.message, 422, MSG.MSG13.code);
  }

  user.password      = newPassword; // Pre-save hook will hash this
  user.tokenVersion = (user.tokenVersion ?? 0) + 1; // revoke every session, including this one
  await user.save();

  await ActivityLog.log({
    eventType:        ActivityEventType.PASSWORD_CHANGED,
    performedBy:      user._id,
    performedByEmail: user.email,
    targetModel:      'User',
    targetId:         user._id,
    summary:          'User changed their own password',
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

  const resetToken  = await generateCryptoToken(32);
  const expiresAt   = dayjs().add(1, 'hour').toDate();

  user.passwordResetToken = { token: resetToken, expiresAt };
  await user.save({ validateBeforeSave: false });

  const resetUrl = `${frontendUrl()}/reset-password?token=${resetToken}`;

  // A delivery failure must not change the response (it would reveal that the
  // email is registered); log it server-side without the reset link.
  try {
    await sendMail({
      to:      user.email,
      toName:  user.fullName,
      subject: 'TrustCar – Yêu cầu đặt lại mật khẩu',
      preheader: 'Đặt lại mật khẩu TrustCar – liên kết có hiệu lực trong 1 giờ.',
      html: `
        <h2 style="margin:0 0 16px;font-size:22px;color:#ffffff;">Đặt lại mật khẩu</h2>
        <p style="margin:0 0 12px;">Xin chào ${escapeHtml(user.fullName)},</p>
        <p style="margin:0;">Chúng tôi đã nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn. Nhấn nút bên dưới để tạo mật khẩu mới:</p>
        ${emailButton('Đặt lại mật khẩu', resetUrl)}
        <p style="margin:0 0 12px;font-size:13px;color:#94a3b8;">Nếu nút không hoạt động, hãy sao chép liên kết sau vào trình duyệt:<br>
          <a href="${resetUrl}" style="color:#3b9fe0;word-break:break-all;">${resetUrl}</a></p>
        <p style="margin:0 0 12px;">Liên kết có hiệu lực trong <strong>1 giờ</strong>.</p>
        <p style="margin:0;color:#94a3b8;">Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này. Mật khẩu hiện tại của bạn vẫn được giữ nguyên.</p>
      `,
    });
  } catch (error) {
    logger.error(`Password reset email failed for user ${user._id}: ${error.message}`);
    return;
  }

  await ActivityLog.log({
    eventType:        ActivityEventType.PASSWORD_RESET,
    performedBy:      user._id,
    performedByEmail: user.email,
    targetModel:      'User',
    targetId:         user._id,
    summary:          'Password reset email dispatched',
  });
};

/**
 * Resets a user's password using the reset token and revokes all sessions.
 * Token check, password write, link removal and tokenVersion bump happen in a
 * single atomic update, so a link can succeed at most once even under
 * concurrent requests. The password is hashed here because atomic updates
 * bypass the pre-save hook.
 * @param {object} params
 * @param {string} params.token
 * @param {string} params.newPassword
 * @returns {Promise<void>}
 */
export const resetPassword = async ({ token, newPassword }) => {
  const invalidLink = () => new AppError(MSG.MSG14.message, MSG.MSG14.httpStatus, MSG.MSG14.code);
  const validLinkFilter = () => ({
    'passwordResetToken.token':     token,
    'passwordResetToken.expiresAt': { $gt: new Date() },
    isActive: true,
  });

  // Cheap pre-check so a bogus token never costs a bcrypt hash on this public endpoint
  if (!(await User.exists(validLinkFilter()))) throw invalidLink();

  const hashedPassword = await User.hashPassword(newPassword);

  // The same condition is re-applied atomically: a concurrent request may have
  // consumed the link between the pre-check and this update.
  const user = await User.findOneAndUpdate(
    validLinkFilter(),
    {
      $set:   { password: hashedPassword },
      $unset: { passwordResetToken: 1 },
      $inc:   { tokenVersion: 1 },
    },
    { new: true }
  );

  if (!user) throw invalidLink();

  await ActivityLog.log({
    eventType:        ActivityEventType.PASSWORD_RESET,
    performedBy:      user._id,
    performedByEmail: user.email,
    targetModel:      'User',
    targetId:         user._id,
    summary:          'Password successfully reset via token',
  });
};

/**
 * Returns the full profile of the currently authenticated user.
 * @param {string} userId
 * @returns {Promise<object>}
 */
export const getMyProfile = async (userId) => {
  const user = await User.findById(userId)
    .select('+password') // only to compute profile status; never returned
    .populate('role', 'name permissions')
    .lean();

  if (!user) throw new AppError(MSG.MSG17.message, 404, MSG.MSG17.code);
  const profileStatus = User.getProfileStatus(user);
  delete user.password;
  return { ...user, ...profileStatus };
};

export default {
  login,
  refreshAccessToken,
  logout,
  changePassword,
  forgotPassword,
  resetPassword,
  getMyProfile,
};
