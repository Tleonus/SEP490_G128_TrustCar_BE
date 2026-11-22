/**
 * @file userRoutes.js
 * @description Internal staff management routes (/api/v1/users).
 * All routes require Admin role (GBR-03).
 */

import { Router } from 'express';
import Joi from 'joi';
import * as userController from '../controllers/userController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireAdmin } from '../middlewares/roleMiddleware.js';
import { validate, validateParams, validateQuery, objectIdParamSchema } from '../middlewares/validateMiddleware.js';
import { joiPassword, joiPhone } from '../utils/validators.js';
import { Roles, StaffRoles } from '../constants/appConstants.js';

const router = Router();

// Apply auth + admin guard to ALL routes in this file
router.use(verifyToken, requireAdmin);

// ── DTO Schemas ────────────────────────────────────────────────────────────

const createUserSchema = Joi.object({
  fullName: Joi.string().trim().min(2).max(100).required().messages({
    'any.required': 'Full name is required.',
  }),
  email: Joi.string().email().lowercase().required().messages({
    'any.required': 'Email is required.',
  }),
  password: joiPassword().required(),
  roleName: Joi.string()
    .valid(...StaffRoles)
    .default(Roles.SALES_STAFF)
    .messages({
      'any.only': `Role must be one of: ${StaffRoles.join(', ')}`,
    }),
  phone: joiPhone().optional(),
});

const updateUserSchema = Joi.object({
  fullName: Joi.string().trim().min(2).max(100),
  phone:    joiPhone().optional(),
  roleName: Joi.string().valid(...StaffRoles).optional(),
}).min(1).messages({
  'object.min': 'At least one field must be provided for update.',
});

const listUsersQuerySchema = Joi.object({
  page:     Joi.number().integer().min(1).default(1),
  limit:    Joi.number().integer().min(1).max(100).default(20),
  roleName: Joi.string().valid(...Object.values(Roles)).optional(),
  // KAN-94: comma-separated list — matches users holding ANY of these roles.
  roles:    Joi.string().trim().max(200).optional(),
  isActive: Joi.boolean().optional(),
  search:   Joi.string().trim().max(100).optional(),
});

// KAN-93: replace the full role set of a staff user.
const updateUserRolesSchema = Joi.object({
  roleIds: Joi.array()
    .items(Joi.string().hex().length(24))
    .min(1)
    .required()
    .messages({
      'array.min':     'At least one role is required.',
      'any.required':  'roleIds is required.',
      'string.hex':    'Each role id must be a valid ObjectId.',
    }),
});

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * @route   POST /api/v1/users
 * @access  Admin only
 * @desc    Create a new internal staff account.
 */
router.post('/', validate(createUserSchema), userController.createUser);

/**
 * @route   GET /api/v1/users
 * @access  Admin only
 * @desc    Paginated list of all staff accounts with optional filters.
 */
router.get('/', validateQuery(listUsersQuerySchema), userController.listUsers);

/**
 * @route   GET /api/v1/users/roles
 * @access  Admin only
 * @desc    Roles assignable to staff accounts (KAN-93). Must be declared before
 *          GET /:id, otherwise "roles" would be read as a user id.
 */
router.get('/roles', userController.listAssignableRoles);

/**
 * @route   GET /api/v1/users/:id
 * @access  Admin only
 * @desc    Retrieve a single user account by ID.
 */
router.get(
  '/:id',
  validateParams(objectIdParamSchema),
  userController.getUserById
);

/**
 * @route   PUT /api/v1/users/:id
 * @access  Admin only
 * @desc    Update mutable profile fields (name, phone, role).
 */
router.put(
  '/:id',
  validateParams(objectIdParamSchema),
  validate(updateUserSchema),
  userController.updateUser
);

/**
 * @route   PUT /api/v1/users/:id/roles
 * @access  Admin only
 * @desc    Replace the full role set of a staff user (KAN-93).
 */
router.put(
  '/:id/roles',
  validateParams(objectIdParamSchema),
  validate(updateUserRolesSchema),
  userController.updateUserRoles
);

/**
 * @route   PATCH /api/v1/users/:id/deactivate
 * @access  Admin only
 * @desc    Deactivates (soft-delete) a staff account. Cannot self-deactivate.
 */
router.patch(
  '/:id/deactivate',
  validateParams(objectIdParamSchema),
  userController.deactivateUser
);

/**
 * @route   PATCH /api/v1/users/:id/activate
 * @access  Admin only
 * @desc    Reactivates a previously deactivated account.
 */
router.patch(
  '/:id/activate',
  validateParams(objectIdParamSchema),
  userController.activateUser
);

export default router;
