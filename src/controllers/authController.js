/**
 * @file authController.js
 * @description Authentication controller – request extraction and response only.
 * Contains ZERO business logic; delegates everything to authService.js.
 *
 * Routes handled:
 * - POST   /api/v1/auth/login
 * - POST   /api/v1/auth/refresh
 * - POST   /api/v1/auth/logout
 * - GET    /api/v1/auth/me
 * - PATCH  /api/v1/auth/change-password
 * - POST   /api/v1/auth/forgot-password
 * - POST   /api/v1/auth/reset-password
 */

import * as authService from '../services/authService.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';

/**
 * @route   POST /api/v1/auth/login
 * @access  Public
 * @body    { email, password }
 */
export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const ipAddress = req.ip || req.connection?.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await authService.login({ email, password, ipAddress, userAgent });

    return sendSuccess(res, 200, 'Login successful.', {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/v1/auth/refresh
 * @access  Public (with refresh token)
 * @body    { refreshToken }
 */
export const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    const result = await authService.refreshAccessToken(refreshToken);
    return sendSuccess(res, 200, 'Access token refreshed.', result);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/v1/auth/logout
 * @access  Protected (verifyToken)
 * @desc    Revokes every access and refresh token of the user on all devices.
 */
export const logout = async (req, res, next) => {
  try {
    await authService.logout({
      userId:    req.userId,
      email:     req.user?.email,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return sendSuccess(res, 200, MSG.MSG09.message);

    return sendSuccess(res, 200, MSG.MSG09.message);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/v1/auth/me
 * @access  Protected (verifyToken)
 * @desc    Returns the authenticated user's own profile.
 */
export const getMyProfile = async (req, res, next) => {
  try {
    const user = await authService.getMyProfile(req.userId);
    return sendSuccess(res, 200, 'Profile retrieved successfully.', user);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PATCH /api/v1/auth/change-password
 * @access  Protected (verifyToken)
 * @body    { currentPassword, newPassword }
 */
export const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    await authService.changePassword({
      userId: req.userId,
      currentPassword,
      newPassword,
      ipAddress: req.ip,
    });

    return sendSuccess(res, 200, 'Password changed successfully. Please log in again.');
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/v1/auth/forgot-password
 * @access  Public
 * @body    { email }
 */
export const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    await authService.forgotPassword(email);
    // Always return success – security: do not reveal whether email exists
    return sendSuccess(
      res, 200,
      'If this email is registered, a password reset link has been sent.'
    );
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/v1/auth/reset-password
 * @access  Public (with reset token)
 * @body    { token, newPassword }
 */
export const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;
    await authService.resetPassword({ token, newPassword });
    return sendSuccess(res, 200, 'Password has been reset successfully. You may now log in.');
  } catch (error) {
    next(error);
  }
};

export default {
  login,
  refreshToken,
  logout,
  getMyProfile,
  changePassword,
  forgotPassword,
  resetPassword,
};
