/**
 * @file profileRoutes.js
 * @description Own-profile routes (/api/v1/profile). Every signed-in account may view and edit its
 * own name and phone; customers also have the extended fields and the settings.
 * Accounts that are not active, or customers whose profile is incomplete, are stopped by
 * `verifyToken` (401 / 403 PROFILE_INCOMPLETE) before anything is read or written.
 *
 * There is no :id anywhere: the account is always the one in the token (no IDOR).
 *
 * Ref: .sdd/features/user-profile-settings/SPEC.md (REQ-001, 014, 016)
 */

import { Router } from 'express';
import * as controller from '../controllers/profileController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireRole } from '../middlewares/roleMiddleware.js';
import { Roles } from '../constants/appConstants.js';
import { validateBodyStrict } from './appointmentSchemas.js';
import { updateProfileSchema, updateSettingsSchema } from './profileSchemas.js';

const router = Router();

router.use(verifyToken);

/** @route GET /profile — own profile (every role) */
router.get('/', controller.getProfile);

/** @route PATCH /profile  { fullName?, phone?, address?, dateOfBirth?, gender? } — own profile (strict body) */
router.patch('/', validateBodyStrict(updateProfileSchema), controller.updateProfile);

/** @route GET /profile/settings — own settings (CUSTOMER only) */
router.get('/settings', requireRole(Roles.CUSTOMER), controller.getSettings);

/** @route PATCH /profile/settings  { marketingConsent } — own settings (CUSTOMER only, strict body) */
router.patch('/settings', requireRole(Roles.CUSTOMER), validateBodyStrict(updateSettingsSchema), controller.updateSettings);

export default router;
