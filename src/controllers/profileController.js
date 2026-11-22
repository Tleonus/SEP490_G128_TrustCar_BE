/**
 * @file profileController.js
 * @description Thin handlers of the profile API: take the account from the token, call the
 * service, answer. No business logic here.
 *
 * Routes handled (mounted at /api/v1/profile):
 * - GET   /           own profile
 * - PATCH /           edit own profile
 * - GET   /settings   own settings (customers)
 * - PATCH /settings   edit own settings (customers)
 *
 * Ref: .sdd/features/user-profile-settings/SPEC.md (REQ-001, 016)
 */

import * as profileService from '../services/profileService.js';
import { sendSuccess } from '../utils/apiResponse.js';

/** Request metadata recorded in the audit log. */
const clientInfo = (req) => ({ ipAddress: req.ip, userAgent: req.headers['user-agent'] });

/** @route GET /api/v1/profile */
export const getProfile = async (req, res, next) => {
  try {
    return sendSuccess(res, 200, 'Profile retrieved successfully.', await profileService.getProfile(req.userId));
  } catch (error) {
    return next(error);
  }
};

/** @route PATCH /api/v1/profile */
export const updateProfile = async (req, res, next) => {
  try {
    const profile = await profileService.updateProfile({ userId: req.userId, body: req.body, ...clientInfo(req) });
    return sendSuccess(res, 200, 'Profile updated successfully.', profile);
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/v1/profile/settings */
export const getSettings = async (req, res, next) => {
  try {
    return sendSuccess(res, 200, 'Settings retrieved successfully.', await profileService.getSettings(req.userId));
  } catch (error) {
    return next(error);
  }
};

/** @route PATCH /api/v1/profile/settings */
export const updateSettings = async (req, res, next) => {
  try {
    const settings = await profileService.updateSettings({ userId: req.userId, body: req.body, ...clientInfo(req) });
    return sendSuccess(res, 200, 'Settings updated successfully.', settings);
  } catch (error) {
    return next(error);
  }
};

export default { getProfile, updateProfile, getSettings, updateSettings };
