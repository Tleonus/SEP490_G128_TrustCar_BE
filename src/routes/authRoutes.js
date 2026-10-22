/**
 * @file authRoutes.js
 * @description Authentication routes (/api/v1/auth).
 *
 * All DTO schemas are defined here and applied via validate() middleware
 * BEFORE the controller is reached. This is the enforcement point for
 * all auth-related input validation.
 */

import { Router } from 'express';
import Joi from 'joi';
import * as authController from '../controllers/authController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { validate } from '../middlewares/validateMiddleware.js';
import { joiPassword } from '../utils/validators.js';

const router = Router();

// ── DTO Schemas ────────────────────────────────────────────────────────────

const loginSchema = Joi.object({
  email:    Joi.string().email().lowercase().required().messages({
    'string.email': 'Please provide a valid email address.',
    'any.required': 'Email is required.',
  }),
  password: Joi.string().required().messages({
    'any.required': 'Password is required.',
  }),
});

const refreshSchema = Joi.object({
  refreshToken: Joi.string().required().messages({
    'any.required': 'Refresh token is required.',
  }),
});

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required().messages({
    'any.required': 'Current password is required.',
  }),
  newPassword: joiPassword().required(),
  confirmPassword: Joi.string()
    .valid(Joi.ref('newPassword'))
    .required()
    .messages({
      'any.only':    'Confirm password must match new password.',
      'any.required': 'Confirm password is required.',
    }),
});

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().lowercase().required(),
});

const resetPasswordSchema = Joi.object({
  token:           Joi.string().required(),
  newPassword:     joiPassword().required(),
  confirmPassword: Joi.string().valid(Joi.ref('newPassword')).required().messages({
    'any.only': 'Confirm password must match new password.',
  }),
});

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * @route   POST /api/v1/auth/login
 * @access  Public
 * @desc    Authenticates user credentials and returns JWT tokens.
 */
router.post('/login', validate(loginSchema), authController.login);

/**
 * @route   POST /api/v1/auth/refresh
 * @access  Public (with valid refresh token)
 * @desc    Issues a new access token using the refresh token.
 */
router.post('/refresh', validate(refreshSchema), authController.refreshToken);

/**
 * @route   POST /api/v1/auth/logout
 * @access  Protected
 * @desc    Logs out the current session (client discards token; server logs event).
 */
router.post('/logout', verifyToken, authController.logout);

/**
 * @route   GET /api/v1/auth/me
 * @access  Protected
 * @desc    Returns the authenticated user's own profile.
 */
router.get('/me', verifyToken, authController.getMyProfile);

/**
 * @route   PATCH /api/v1/auth/change-password
 * @access  Protected
 * @desc    Changes the authenticated user's own password.
 */
router.patch(
  '/change-password',
  verifyToken,
  validate(changePasswordSchema),
  authController.changePassword
);

/**
 * @route   POST /api/v1/auth/forgot-password
 * @access  Public
 * @desc    Sends a password reset email to the provided address.
 */
router.post('/forgot-password', validate(forgotPasswordSchema), authController.forgotPassword);

/**
 * @route   POST /api/v1/auth/reset-password
 * @access  Public (with valid reset token)
 * @desc    Resets the password using the token received by email.
 */
router.post('/reset-password', validate(resetPasswordSchema), authController.resetPassword);

export default router;
