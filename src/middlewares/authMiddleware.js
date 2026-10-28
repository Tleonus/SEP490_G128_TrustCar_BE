/**
 * @file authMiddleware.js
 * @description JWT verification middleware implementing the Chain of Responsibility pattern.
 *
 * Enforces:
 * - GBR-01: Valid, unexpired JWT Bearer token required on all protected routes.
 * - GBR-21: Active session enforcement (deactivated accounts rejected even with valid JWT).
 * - Only access tokens are accepted, and only while their `tv` claim matches the
 *   user's tokenVersion (logout / password change / reset revoke older tokens).
 *
 * Exports:
 * - verifyToken: Middleware that validates JWT and attaches req.user; customers
 *   whose profile is incomplete are rejected with PROFILE_INCOMPLETE.
 * - verifyTokenAllowIncomplete: Same, but lets incomplete customer profiles through
 *   (used by /auth/me, /auth/logout and /auth/complete-profile).
 * - optionalAuth: Same as verifyToken but does not fail if no token is present.
 */

import User from '../models/User.js';
import { TokenType, verifyTokenOfType, isTokenCurrent } from '../utils/authTokens.js';
import { AppError } from '../utils/apiResponse.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';

/**
 * Extracts the Bearer token from the Authorization header.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
const extractToken = (req) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
};

/**
 * Builds the token-verification middleware.
 * Validates JWT, checks expiry, confirms the account is still active and – unless
 * allowIncomplete – that a customer's profile is complete.
 * Attaches the user (minus password) and its profile status to req.
 *
 * Ref: GBR-01, GBR-21
 * @param {{ allowIncomplete?: boolean }} [options]
 */
const authenticate = ({ allowIncomplete = false } = {}) => async (req, res, next) => {
  try {
    const token = extractToken(req);

    // GBR-01: Token must be present
    if (!token) {
      return next(new AppError(MSG.MSG01.message, MSG.MSG01.httpStatus, MSG.MSG01.code));
    }

    // Verify signature, expiry, issuer/audience and that it is an access token
    let decoded;
    try {
      decoded = verifyTokenOfType(token, TokenType.ACCESS);
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return next(new AppError(MSG.MSG02.message, MSG.MSG02.httpStatus, MSG.MSG02.code));
      }
      return next(new AppError(MSG.MSG03.message, MSG.MSG03.httpStatus, MSG.MSG03.code));
    }

    // GBR-21: Secondary DB check – account must still be active
    // '+password' only to know whether one is set (profile status); removed below.
    const user = await User.findById(decoded.userId).select('+tokenVersion +password').populate('role').lean();

    // Unknown user, or token issued before the latest logout / password change
    if (!user || !isTokenCurrent(decoded, user)) {
      return next(new AppError(MSG.MSG03.message, MSG.MSG03.httpStatus, MSG.MSG03.code));
    }

    const profileStatus = User.getProfileStatus(user);
    delete user.tokenVersion; // keep revocation data out of req.user
    delete user.password;

    if (!user.isActive) {
      return next(new AppError(MSG.MSG06.message, MSG.MSG06.httpStatus, MSG.MSG06.code));
    }

    if (!profileStatus.profileCompleted && !allowIncomplete) {
      return next(new AppError(MSG.MSG74.message, MSG.MSG74.httpStatus, MSG.MSG74.code));
    }

    // Attach user context to request (never includes password – lean() + select behaviour)
    req.user      = user;
    req.userId    = user._id.toString();
    req.userRole  = user.roleName;
    req.token     = token;
    req.profileStatus = profileStatus;

    next();
  } catch (error) {
    next(error);
  }
};

/** @middleware verifyToken – protected routes; incomplete customer profiles get 403. */
export const verifyToken = authenticate();

/** @middleware verifyTokenAllowIncomplete – routes a customer needs to finish their profile. */
export const verifyTokenAllowIncomplete = authenticate({ allowIncomplete: true });

/**
 * @middleware optionalAuth
 * Attempts to authenticate the caller but does NOT fail if no/invalid token.
 * Useful for public endpoints that show extra data to authenticated users.
 */
export const optionalAuth = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) return next(); // Anonymous – continue without req.user

    let decoded;
    try {
      decoded = verifyTokenOfType(token, TokenType.ACCESS);
    } catch {
      return next(); // Invalid / wrong-type token – continue anonymously
    }

    const user = await User.findById(decoded.userId).select('+tokenVersion').lean();
    if (user && user.isActive && isTokenCurrent(decoded, user)) {
      delete user.tokenVersion;
      req.user     = user;
      req.userId   = user._id.toString();
      req.userRole = user.roleName;
    }

    next();
  } catch {
    next(); // Never fail – continue anonymously
  }
};

export default { verifyToken, verifyTokenAllowIncomplete, optionalAuth };
