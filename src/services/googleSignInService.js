/**
 * @file googleSignInService.js
 * @description Google sign-in / sign-up for website customers through Firebase.
 * Creates an incomplete CUSTOMER account on first use, links Google to an
 * existing customer account with the same email, and refuses staff accounts.
 * Sessions are issued exactly like a KAN-9 login.
 * This layer contains ZERO Express req/res references.
 */

import User from '../models/User.js';
import ActivityLog from '../models/ActivityLog.js';
import { verifyGoogleIdToken } from '../config/firebase.js';
import logger from '../utils/logger.js';
import { ActivityEventType, Roles } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import {
  ACCOUNT_FIELDS,
  appError,
  issueSession,
  mapDuplicateKeyError,
  resolveCustomerRole,
} from './customerRegistrationService.js';

/** Verifies the Google ID token; maps adapter failures to API errors (never logs the token). */
const verifyGoogleIdentity = async (idToken) => {
  try {
    return await verifyGoogleIdToken(idToken);
  } catch (error) {
    if (error.kind === 'UNAVAILABLE') {
      logger.error(`Google sign-in verification unavailable: ${error.message}`);
      throw appError(MSG.MSG73);
    }
    throw appError(MSG.MSG70);
  }
};

/**
 * Signs a customer in with Google, creating or linking the account as needed.
 * Ref: REQ-006…013, REQ-028
 *
 * - Google identity already linked        → sign in (200)
 * - email of a customer without Google    → link Google to it, sign in (200)
 * - email of a staff account              → 403 GOOGLE_LOGIN_NOT_ALLOWED
 * - email linked to another Google id     → 409 GOOGLE_ACCOUNT_CONFLICT
 * - no account                            → create an incomplete CUSTOMER account (201)
 *
 * @param {object} params
 * @param {string} params.idToken - Firebase ID token from the client SDK
 * @param {string} [params.ipAddress]
 * @param {string} [params.userAgent]
 * @returns {Promise<{ created: boolean, user: object, accessToken: string, refreshToken: string }>}
 */
export const googleSignIn = async ({ idToken, ipAddress, userAgent }) => {
  const identity = await verifyGoogleIdentity(idToken);
  const audit = { ipAddress, userAgent, targetModel: 'User' };

  let user = await User.findOne({ firebaseUid: identity.uid }).select(ACCOUNT_FIELDS);
  let linkGoogle = false;

  if (!user) {
    const byEmail = await User.findOne({ email: identity.email }).select(ACCOUNT_FIELDS);
    if (byEmail) {
      if (byEmail.roleName !== Roles.CUSTOMER) throw appError(MSG.MSG71);
      if (byEmail.firebaseUid) throw appError(MSG.MSG72);
      user = byEmail;
      linkGoogle = true;
    }
  }

  // ── No account yet → create an incomplete customer account
  if (!user) {
    const role = await resolveCustomerRole();
    try {
      user = await User.create({
        fullName:    identity.name || undefined,
        email:       identity.email,
        firebaseUid: identity.uid,
        role:        role._id,
        roleName:    Roles.CUSTOMER,
        lastLoginAt: new Date(),
        lastLoginIp: ipAddress || null,
      });
    } catch (error) {
      throw mapDuplicateKeyError(error);
    }

    await ActivityLog.log({
      ...audit,
      eventType:        ActivityEventType.CUSTOMER_REGISTERED,
      performedBy:      user._id,
      performedByEmail: user.email,
      targetId:         user._id,
      summary:          'Customer registered with Google (profile incomplete)',
    });

    return { created: true, ...issueSession(user) };
  }

  if (!user.isActive) throw appError(MSG.MSG06);

  if (linkGoogle) user.firebaseUid = identity.uid;
  user.lastLoginAt = new Date();
  user.lastLoginIp = ipAddress || null;
  try {
    await user.save({ validateBeforeSave: false });
  } catch (error) {
    throw mapDuplicateKeyError(error);
  }

  const logEntry = { ...audit, performedBy: user._id, performedByEmail: user.email, targetId: user._id };
  if (linkGoogle) {
    await ActivityLog.log({ ...logEntry, eventType: ActivityEventType.GOOGLE_LINKED, summary: 'Google account linked to existing customer account' });
  }
  await ActivityLog.log({ ...logEntry, eventType: ActivityEventType.USER_LOGIN, summary: `Successful Google sign-in from ${ipAddress || 'unknown IP'}` });

  return { created: false, ...issueSession(user) };
};

export default { googleSignIn };
