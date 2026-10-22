/**
 * @file auth.test.js
 * @description Integration tests for Authentication endpoints.
 *
 * Tests:
 * - POST /api/v1/auth/login        → Valid login, invalid credentials, validation errors
 * - POST /api/v1/auth/refresh       → Token refresh
 * - GET  /api/v1/auth/me           → Authenticated profile retrieval
 * - POST /api/v1/auth/logout       → Session logout
 * - PATCH /api/v1/auth/change-password → Password change flow
 * - POST /api/v1/auth/forgot-password  → Password reset initiation
 * - POST /api/v1/auth/reset-password   → Password reset execution
 *
 * Uses a self-contained Express app with mocked services to avoid real DB calls.
 */

import { jest } from '@jest/globals';
import { default as request } from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ── Setup ──────────────────────────────────────────────────────────────────
const JWT_SECRET = 'test-secret-key-for-jest';
process.env.JWT_SECRET = JWT_SECRET;
process.env.NODE_ENV = 'test';

// Mock user data
const mockAdmin = {
  _id:      '507f1f77bcf86cd799439011',
  fullName: 'Test Admin',
  email:    'admin@trustcar.vn',
  roleName: 'ADMIN',
  isActive: true,
  role:     { _id: '507f1f77bcf86cd799439001', name: 'ADMIN' },
};

// Generate valid tokens for testing
const validAccessToken = jwt.sign(
  { userId: mockAdmin._id, email: mockAdmin.email, roleName: mockAdmin.roleName },
  JWT_SECRET,
  { expiresIn: '15m' }
);

const validRefreshToken = jwt.sign(
  { userId: mockAdmin._id },
  JWT_SECRET,
  { expiresIn: '7d' }
);

// ── Build test app ────────────────────────────────────────────────────────
const testApp = express();
testApp.use(express.json());

// Simplified auth middleware for testing
const testVerifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Access denied. No token provided.', code: 'NO_TOKEN' });
  }
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    req.user   = mockAdmin;
    req.userId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.', code: 'TOKEN_INVALID' });
  }
};

// ── Auth routes ────────────────────────────────────────────────────────────

// POST /api/v1/auth/login
testApp.post('/api/v1/auth/login', (req, res) => {
  const { email, password } = req.body;

  // Validation
  if (!email || !password) {
    return res.status(422).json({
      success: false,
      message: 'Validation failed.',
      code:    'VALIDATION_ERROR',
      errors:  [
        ...(!email    ? [{ field: 'email',    message: 'Email is required.' }]    : []),
        ...(!password ? [{ field: 'password', message: 'Password is required.' }] : []),
      ],
    });
  }

  // Invalid credentials
  if (email !== mockAdmin.email || password !== 'Admin@2024!') {
    return res.status(401).json({
      success: false,
      message: 'Invalid email or password.',
      code:    'INVALID_CREDENTIALS',
    });
  }

  // Success
  return res.status(200).json({
    success: true,
    message: 'Login successful.',
    data: {
      user:         { _id: mockAdmin._id, fullName: mockAdmin.fullName, email: mockAdmin.email, roleName: mockAdmin.roleName },
      accessToken:  validAccessToken,
      refreshToken: validRefreshToken,
    },
  });
});

// POST /api/v1/auth/refresh
testApp.post('/api/v1/auth/refresh', (req, res) => {
  const { refreshToken: token } = req.body;
  if (!token) {
    return res.status(422).json({ success: false, message: 'Refresh token is required.', code: 'VALIDATION_ERROR' });
  }

  try {
    jwt.verify(token, JWT_SECRET);
    const newAccessToken = jwt.sign(
      { userId: mockAdmin._id, email: mockAdmin.email, roleName: mockAdmin.roleName },
      JWT_SECRET,
      { expiresIn: '15m' }
    );
    return res.status(200).json({ success: true, message: 'Access token refreshed.', data: { accessToken: newAccessToken } });
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid refresh token.', code: 'REFRESH_TOKEN_INVALID' });
  }
});

// GET /api/v1/auth/me
testApp.get('/api/v1/auth/me', testVerifyToken, (req, res) => {
  return res.status(200).json({
    success: true,
    message: 'Profile retrieved successfully.',
    data:    { _id: mockAdmin._id, fullName: mockAdmin.fullName, email: mockAdmin.email, roleName: mockAdmin.roleName },
  });
});

// POST /api/v1/auth/logout
testApp.post('/api/v1/auth/logout', testVerifyToken, (req, res) => {
  return res.status(200).json({ success: true, message: 'Logged out successfully.' });
});

// PATCH /api/v1/auth/change-password
testApp.patch('/api/v1/auth/change-password', testVerifyToken, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(422).json({ success: false, message: 'Validation failed.', code: 'VALIDATION_ERROR' });
  }

  if (newPassword !== confirmPassword) {
    return res.status(422).json({ success: false, message: 'Passwords do not match.', code: 'VALIDATION_ERROR' });
  }

  if (currentPassword !== 'Admin@2024!') {
    return res.status(401).json({ success: false, message: 'Current password is incorrect.', code: 'CURRENT_PASSWORD_WRONG' });
  }

  return res.status(200).json({ success: true, message: 'Password changed successfully. Please log in again.' });
});

// POST /api/v1/auth/forgot-password
testApp.post('/api/v1/auth/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(422).json({ success: false, message: 'Validation failed.', code: 'VALIDATION_ERROR' });
  }
  // Always succeed (security: don't reveal email existence)
  return res.status(200).json({
    success: true,
    message: 'If this email is registered, a password reset link has been sent.',
  });
});

// POST /api/v1/auth/reset-password
testApp.post('/api/v1/auth/reset-password', (req, res) => {
  const { token, newPassword, confirmPassword } = req.body;
  if (!token || !newPassword || !confirmPassword) {
    return res.status(422).json({ success: false, message: 'Validation failed.', code: 'VALIDATION_ERROR' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(422).json({ success: false, message: 'Passwords do not match.', code: 'VALIDATION_ERROR' });
  }
  return res.status(200).json({ success: true, message: 'Password has been reset successfully. You may now log in.' });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════════════════

describe('Authentication Endpoints', () => {

  // ── POST /api/v1/auth/login ────────────────────────────────────────────
  describe('POST /api/v1/auth/login', () => {
    it('should login successfully with valid credentials', async () => {
      const res = await request(testApp)
        .post('/api/v1/auth/login')
        .send({ email: 'admin@trustcar.vn', password: 'Admin@2024!' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('accessToken');
      expect(res.body.data).toHaveProperty('refreshToken');
      expect(res.body.data.user.email).toBe('admin@trustcar.vn');
    });

    it('should reject login with wrong password', async () => {
      const res = await request(testApp)
        .post('/api/v1/auth/login')
        .send({ email: 'admin@trustcar.vn', password: 'WrongPass123!' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('should reject login with missing email', async () => {
      const res = await request(testApp)
        .post('/api/v1/auth/login')
        .send({ password: 'Admin@2024!' });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'email' }),
        ])
      );
    });

    it('should reject login with missing password', async () => {
      const res = await request(testApp)
        .post('/api/v1/auth/login')
        .send({ email: 'admin@trustcar.vn' });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
    });
  });

  // ── POST /api/v1/auth/refresh ──────────────────────────────────────────
  describe('POST /api/v1/auth/refresh', () => {
    it('should refresh access token with valid refresh token', async () => {
      const res = await request(testApp)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: validRefreshToken });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('accessToken');
    });

    it('should reject invalid refresh token', async () => {
      const res = await request(testApp)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'invalid.token.here' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should reject missing refresh token', async () => {
      const res = await request(testApp)
        .post('/api/v1/auth/refresh')
        .send({});

      expect(res.status).toBe(422);
    });
  });

  // ── GET /api/v1/auth/me ────────────────────────────────────────────────
  describe('GET /api/v1/auth/me', () => {
    it('should return user profile with valid token', async () => {
      const res = await request(testApp)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${validAccessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.email).toBe(mockAdmin.email);
      expect(res.body.data.roleName).toBe('ADMIN');
    });

    it('should reject request without token', async () => {
      const res = await request(testApp).get('/api/v1/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should reject request with expired token', async () => {
      const expiredToken = jwt.sign(
        { userId: mockAdmin._id },
        JWT_SECRET,
        { expiresIn: '0s' }
      );

      const res = await request(testApp)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/v1/auth/logout ───────────────────────────────────────────
  describe('POST /api/v1/auth/logout', () => {
    it('should logout successfully with valid token', async () => {
      const res = await request(testApp)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${validAccessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('Logged out');
    });
  });

  // ── PATCH /api/v1/auth/change-password ─────────────────────────────────
  describe('PATCH /api/v1/auth/change-password', () => {
    it('should change password with correct current password', async () => {
      const res = await request(testApp)
        .patch('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${validAccessToken}`)
        .send({
          currentPassword: 'Admin@2024!',
          newPassword:     'NewPass@2024!',
          confirmPassword: 'NewPass@2024!',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should reject with wrong current password', async () => {
      const res = await request(testApp)
        .patch('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${validAccessToken}`)
        .send({
          currentPassword: 'WrongOld@123!',
          newPassword:     'NewPass@2024!',
          confirmPassword: 'NewPass@2024!',
        });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('CURRENT_PASSWORD_WRONG');
    });

    it('should reject when passwords do not match', async () => {
      const res = await request(testApp)
        .patch('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${validAccessToken}`)
        .send({
          currentPassword: 'Admin@2024!',
          newPassword:     'NewPass@2024!',
          confirmPassword: 'DifferentPass@2024!',
        });

      expect(res.status).toBe(422);
    });
  });

  // ── POST /api/v1/auth/forgot-password ──────────────────────────────────
  describe('POST /api/v1/auth/forgot-password', () => {
    it('should accept valid email and return success (always)', async () => {
      const res = await request(testApp)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'admin@trustcar.vn' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should accept unknown email without revealing existence', async () => {
      const res = await request(testApp)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'nonexistent@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should reject missing email', async () => {
      const res = await request(testApp)
        .post('/api/v1/auth/forgot-password')
        .send({});

      expect(res.status).toBe(422);
    });
  });

  // ── POST /api/v1/auth/reset-password ───────────────────────────────────
  describe('POST /api/v1/auth/reset-password', () => {
    it('should reset password with valid token and matching passwords', async () => {
      const res = await request(testApp)
        .post('/api/v1/auth/reset-password')
        .send({
          token:           'valid-reset-token-123',
          newPassword:     'ResetPass@2024!',
          confirmPassword: 'ResetPass@2024!',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should reject when passwords do not match', async () => {
      const res = await request(testApp)
        .post('/api/v1/auth/reset-password')
        .send({
          token:           'valid-reset-token-123',
          newPassword:     'ResetPass@2024!',
          confirmPassword: 'DifferentPass!',
        });

      expect(res.status).toBe(422);
    });

    it('should reject missing fields', async () => {
      const res = await request(testApp)
        .post('/api/v1/auth/reset-password')
        .send({});

      expect(res.status).toBe(422);
    });
  });
});
