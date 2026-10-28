/**
 * @file firebase.js
 * @description Firebase Authentication adapter used to verify Google sign-in
 * ID tokens issued to the frontend by the Firebase client SDK.
 *
 * Only token verification is used, which needs nothing but the Firebase
 * project ID (Google's public signing keys are fetched by firebase-admin).
 * No service account / private key is required.
 *
 * Env: FIREBASE_PROJECT_ID
 *
 * Usage:
 *   import { verifyGoogleIdToken, GoogleTokenError } from '../config/firebase.js';
 *   const identity = await verifyGoogleIdToken(idToken);
 */

import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const APP_NAME = 'trustcar-auth';
const VERIFY_TIMEOUT_MS = 10_000;
const GOOGLE_PROVIDER = 'google.com';

/**
 * Error raised by verifyGoogleIdToken.
 * kind = 'INVALID'     → the token itself is bad (forged, expired, wrong project, unverified email)
 * kind = 'UNAVAILABLE' → Firebase/Google could not be reached or the adapter is not configured
 */
export class GoogleTokenError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'GoogleTokenError';
    this.kind = kind;
  }
}

/** Lazily creates (once) the Firebase app bound to FIREBASE_PROJECT_ID. */
const getFirebaseAuth = () => {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    throw new GoogleTokenError('UNAVAILABLE', 'FIREBASE_PROJECT_ID is not configured.');
  }
  const app = getApps().find((a) => a.name === APP_NAME) || initializeApp({ projectId }, APP_NAME);
  return getAuth(app);
};

const withTimeout = (promise, ms) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new GoogleTokenError('UNAVAILABLE', 'Firebase token verification timed out.')),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/** Firebase "auth/*" errors describe the token; anything else is an outage. */
const classify = (error) => {
  if (error instanceof GoogleTokenError) return error;
  const code = error?.code || error?.errorInfo?.code || '';
  if (code.startsWith('auth/') && code !== 'auth/internal-error') {
    return new GoogleTokenError('INVALID', `Google ID token rejected (${code}).`);
  }
  return new GoogleTokenError('UNAVAILABLE', `Firebase verification unavailable (${code || error?.message}).`);
};

/**
 * Verifies a Firebase ID token from Google sign-in.
 * The token value is never included in thrown messages or logs.
 *
 * @param {string} idToken
 * @returns {Promise<{ uid: string, email: string|null, emailVerified: boolean, name: string|null }>}
 * @throws {GoogleTokenError}
 */
export const verifyGoogleIdToken = async (idToken) => {
  try {
    const decoded = await withTimeout(getFirebaseAuth().verifyIdToken(idToken), VERIFY_TIMEOUT_MS);
    const identity = {
      uid:           decoded.uid,
      email:         decoded.email ? decoded.email.toLowerCase() : null,
      emailVerified: decoded.email_verified === true,
      name:          decoded.name ? String(decoded.name).trim() || null : null,
    };
    // Only Google sign-ins are accepted, even if other providers get enabled in the Firebase project.
    if (decoded.firebase?.sign_in_provider !== GOOGLE_PROVIDER) {
      throw new GoogleTokenError('INVALID', 'Token was not issued for a Google sign-in.');
    }
    if (!identity.email || !identity.emailVerified) {
      throw new GoogleTokenError('INVALID', 'Google account email is missing or not verified.');
    }
    return identity;
  } catch (error) {
    throw classify(error);
  }
};

export default { verifyGoogleIdToken, GoogleTokenError };
