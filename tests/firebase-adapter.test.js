/**
 * @file firebase-adapter.test.js
 * @description Unit tests for src/config/firebase.js with firebase-admin mocked
 * (no network calls to Google/Firebase).
 */

import { jest } from '@jest/globals';

const verifyIdToken = jest.fn();

jest.unstable_mockModule('firebase-admin/app', () => ({
  getApps:       () => [],
  initializeApp: jest.fn((options, name) => ({ name, options })),
}));
jest.unstable_mockModule('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken }),
}));

const { verifyGoogleIdToken, GoogleTokenError } = await import('../src/config/firebase.js');

const authError = (code) => Object.assign(new Error(code), { code });
const google = { firebase: { sign_in_provider: 'google.com' } };

beforeEach(() => {
  verifyIdToken.mockReset();
  process.env.FIREBASE_PROJECT_ID = 'trustcar-test';
});

describe('verifyGoogleIdToken', () => {
  test('returns a normalised identity for a valid token with a verified email', async () => {
    verifyIdToken.mockResolvedValue({ ...google, uid: 'u1', email: 'An@Gmail.com', email_verified: true, name: ' An Nguyen ' });

    await expect(verifyGoogleIdToken('tok')).resolves.toEqual({
      uid: 'u1', email: 'an@gmail.com', emailVerified: true, name: 'An Nguyen',
    });
  });

  test('missing name becomes null', async () => {
    verifyIdToken.mockResolvedValue({ ...google, uid: 'u1', email: 'a@gmail.com', email_verified: true });
    await expect(verifyGoogleIdToken('tok')).resolves.toMatchObject({ name: null });
  });

  test.each(['password', 'facebook.com', 'anonymous'])('AC-22: sign-in provider %s → INVALID', async (provider) => {
    verifyIdToken.mockResolvedValue({
      uid: 'u1', email: 'a@gmail.com', email_verified: true, firebase: { sign_in_provider: provider },
    });
    await expect(verifyGoogleIdToken('tok')).rejects.toMatchObject({ kind: 'INVALID' });
  });

  test('missing provider information → INVALID', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'u1', email: 'a@gmail.com', email_verified: true });
    await expect(verifyGoogleIdToken('tok')).rejects.toMatchObject({ kind: 'INVALID' });
  });

  test('unverified email → INVALID', async () => {
    verifyIdToken.mockResolvedValue({ ...google, uid: 'u1', email: 'a@gmail.com', email_verified: false });
    await expect(verifyGoogleIdToken('tok')).rejects.toMatchObject({ kind: 'INVALID' });
  });

  test.each(['auth/id-token-expired', 'auth/argument-error', 'auth/invalid-id-token'])(
    'Firebase %s → INVALID', async (code) => {
      verifyIdToken.mockRejectedValue(authError(code));
      await expect(verifyGoogleIdToken('tok')).rejects.toMatchObject({ kind: 'INVALID' });
    }
  );

  test('network / internal errors → UNAVAILABLE', async () => {
    verifyIdToken.mockRejectedValue(authError('app/network-error'));
    await expect(verifyGoogleIdToken('tok')).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    verifyIdToken.mockRejectedValue(authError('auth/internal-error'));
    await expect(verifyGoogleIdToken('tok')).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
  });

  test('missing FIREBASE_PROJECT_ID → UNAVAILABLE without calling Firebase', async () => {
    delete process.env.FIREBASE_PROJECT_ID;
    await expect(verifyGoogleIdToken('tok')).rejects.toBeInstanceOf(GoogleTokenError);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  test('times out after 10 seconds → UNAVAILABLE', async () => {
    jest.useFakeTimers();
    verifyIdToken.mockReturnValue(new Promise(() => {}));
    const pending = verifyGoogleIdToken('tok');
    jest.advanceTimersByTime(10_000);
    await expect(pending).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    jest.useRealTimers();
  });

  test('error messages never contain the token value', async () => {
    verifyIdToken.mockRejectedValue(authError('auth/invalid-id-token'));
    const error = await verifyGoogleIdToken('SECRET-TOKEN-123').catch((e) => e);
    expect(error).toBeInstanceOf(GoogleTokenError);
    expect(error.message).not.toContain('SECRET-TOKEN-123');
  });
});
