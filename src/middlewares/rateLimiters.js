/**
 * @file rateLimiters.js
 * @description API rate limits. Signed-in callers get their own quota per account, so
 * people behind one IP do not block each other; anonymous callers share a quota per IP.
 *
 * Quotas per 15 minutes, changed through the environment (restart required). A value
 * that is not a positive whole number falls back to the default:
 *   RATE_LIMIT_MAX           anonymous, per IP       (default 1000)
 *   RATE_LIMIT_CUSTOMER_MAX  customer, per account   (default 600)
 *   RATE_LIMIT_STAFF_MAX     any other role, per account (default 2000)
 *
 * Counters live in this process: they reset on restart and are not shared between
 * instances, so running several instances multiplies the effective quota.
 *
 * @ears .sdd/features/api-rate-limit-per-account/SPEC.md#REQ-001
 * @ears .sdd/features/api-rate-limit-per-account/SPEC.md#REQ-004
 * @ears .sdd/features/api-rate-limit-per-account/SPEC.md#REQ-007
 * @ears .sdd/features/api-rate-limit-per-account/SPEC.md#REQ-009
 */

import rateLimit from 'express-rate-limit';
import { Roles } from '../constants/appConstants.js';
import { TokenType, verifyTokenOfType } from '../utils/authTokens.js';
import { extractToken } from './authMiddleware.js';

const WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX = 30;
const LOGOUT_PATH = '/api/v1/auth/logout';
const PROFILE_PATH = '/api/v1/auth/me';

/**
 * @param {string|undefined} value - Raw environment value.
 * @param {number} fallback
 * @returns {number} The value when it is a positive whole number, otherwise the fallback.
 */
export const resolveLimit = (value, fallback) => {
  // Digits only: Number() also accepts forms like 0x10 and 1e3, which are likely typos here.
  const isPositiveWhole = /^[1-9]\d*$/.test(value ?? '') && Number.isSafeInteger(Number(value));
  return isPositiveWhole ? Number(value) : fallback;
};

export const limitsFromEnv = (env = process.env) => ({
  ip: resolveLimit(env.RATE_LIMIT_MAX, 1000),
  customer: resolveLimit(env.RATE_LIMIT_CUSTOMER_MAX, 600),
  staff: resolveLimit(env.RATE_LIMIT_STAFF_MAX, 2000),
});

/**
 * Records who is calling when the access token is genuine. Checks the token only, with
 * no database lookup, and never rejects: a bad token is counted as anonymous and the
 * route's own authentication answers it.
 */
export const identifyCaller = (req, _res, next) => {
  const token = extractToken(req);
  if (token) {
    try {
      const { userId, roleName } = verifyTokenOfType(token, TokenType.ACCESS);
      req.rateLimitCaller = { userId, roleName };
    } catch {
      // Forged or expired: stays anonymous, so changing token cannot earn a new quota.
    }
  }
  next();
};

const isSignedInRequest = (req, method, path) =>
  Boolean(req.rateLimitCaller) && req.method === method && req.originalUrl.split('?')[0] === path;

const isLogout = (req) => isSignedInRequest(req, 'POST', LOGOUT_PATH);
const isProfile = (req) => isSignedInRequest(req, 'GET', PROFILE_PATH);

/** Must run after identifyCaller. */
export const createGlobalLimiter = (limits = limitsFromEnv()) => rateLimit({
  windowMs: WINDOW_MS,
  max: ({ rateLimitCaller: caller }) => {
    if (!caller) return limits.ip;
    return caller.roleName === Roles.CUSTOMER ? limits.customer : limits.staff;
  },
  keyGenerator: (req) => (req.rateLimitCaller ? `user:${req.rateLimitCaller.userId}` : `ip:${req.ip}`),
  skip: isLogout,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests. Please try again later.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

/**
 * Strict limit against password guessing, always per IP. Must run after identifyCaller.
 * Logout and profile need a valid token and cannot be used to guess a password.
 */
export const createAuthLimiter = (max = AUTH_MAX) => rateLimit({
  windowMs: WINDOW_MS,
  max,
  skip: (req) => isLogout(req) || isProfile(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again in 15 minutes.',
    code: 'AUTH_RATE_LIMIT',
  },
});

/**
 * Cap on caption generations per caller per calendar day (KAN-68 §6).
 *
 * Separate from the global 15-minute quota because the cost model is different:
 * each call may hit a paid model. Keyed by the authenticated user, so one account
 * cannot reset its allowance by changing IP or token. `verifyToken` must run
 * before this so `req.userId` is populated — `req.user` is a lean document and
 * has no `.id` virtual, so we key on `req.userId` (set from `user._id.toString()`).
 *
 * @param {number} [max=20]
 */
export const createDailyCaptionLimiter = (max = resolveLimit(process.env.CAPTION_DAILY_LIMIT, 20)) => rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max,
  keyGenerator: (req) => `caption:${req.userId ?? req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: `Daily caption limit reached (${max} per day). Please try again tomorrow.`,
    code: 'CAPTION_DAILY_LIMIT',
  },
});

export default {
  identifyCaller, createGlobalLimiter, createAuthLimiter, createDailyCaptionLimiter, limitsFromEnv, resolveLimit,
};

