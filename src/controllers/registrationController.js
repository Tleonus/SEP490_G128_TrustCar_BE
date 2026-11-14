/**
 * @file registrationController.js
 * @description Customer self-registration endpoints – request extraction and
 * response only; business logic lives in customerRegistrationService.js and
 * googleSignInService.js.
 *
 * Routes handled:
 * - POST /api/v1/auth/register
 * - POST /api/v1/auth/google
 * - PATCH /api/v1/auth/complete-profile
 */

import * as registrationService from '../services/customerRegistrationService.js';
import { googleSignIn as googleSignInService } from '../services/googleSignInService.js';
import { sendSuccess } from '../utils/apiResponse.js';

/** Request metadata recorded in the audit log. */
const clientInfo = (req) => ({
  ipAddress: req.ip,
  userAgent: req.headers['user-agent'],
});

/**
 * @route   POST /api/v1/auth/register
 * @access  Public
 * @body    { email, password, confirmPassword, fullName, phone }
 */
export const register = async (req, res, next) => {
  try {
    const { email, password, fullName, phone } = req.body;
    const result = await registrationService.register({ email, password, fullName, phone, ...clientInfo(req) });
    return sendSuccess(res, 201, 'Registration successful.', result);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/v1/auth/google
 * @access  Public
 * @body    { idToken } – Firebase ID token from Google sign-in on the client
 * @desc    201 when a new (incomplete) customer account was created, 200 when signing in.
 */
export const googleSignIn = async (req, res, next) => {
  try {
    const { created, ...session } = await googleSignInService({ idToken: req.body.idToken, ...clientInfo(req) });
    return sendSuccess(
      res,
      created ? 201 : 200,
      created ? 'Account created with Google. Please complete your profile.' : 'Login successful.',
      session
    );
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PATCH /api/v1/auth/complete-profile
 * @access  Protected (incomplete profiles allowed)
 * @body    { fullName?, phone?, password?, confirmPassword? } – exactly the missing fields
 */
export const completeProfile = async (req, res, next) => {
  try {
    const { fullName, phone, password } = req.body;
    const user = await registrationService.completeProfile({
      userId: req.userId,
      fields: { fullName, phone, password },
      ...clientInfo(req),
    });
    return sendSuccess(res, 200, 'Profile updated successfully.', user);
  } catch (error) {
    next(error);
  }
};

export default { register, googleSignIn, completeProfile };
