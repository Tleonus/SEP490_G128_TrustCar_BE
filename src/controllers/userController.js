/**
 * @file userController.js
 * @description Internal staff management controller (Admin-only).
 * Contains ZERO business logic; delegates everything to userService.js.
 *
 * Routes handled:
 * - POST   /api/v1/users            → createUser
 * - GET    /api/v1/users            → listUsers
 * - GET    /api/v1/users/:id        → getUserById
 * - PUT    /api/v1/users/:id        → updateUser
 * - PATCH  /api/v1/users/:id/deactivate  → deactivateUser
 * - PATCH  /api/v1/users/:id/activate    → activateUser
 */

import * as userService from '../services/userService.js';
import { sendSuccess, sendPaginated } from '../utils/apiResponse.js';

/**
 * @route   POST /api/v1/users
 * @access  Admin only
 * @body    { fullName, email, password, roleName, phone? }
 */
export const createUser = async (req, res, next) => {
  try {
    const user = await userService.createUser({
      ...req.body,
      createdByUserId: req.userId,
      ipAddress:       req.ip,
    });
    return sendSuccess(res, 201, 'User account created successfully.', user);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/v1/users
 * @access  Admin only
 * @query   { page, limit, roleName, isActive, search }
 */
export const listUsers = async (req, res, next) => {
  try {
    const { items, pagination } = await userService.getUsers(req.query);
    return sendPaginated(res, 'Users retrieved successfully.', items, pagination);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/v1/users/:id
 * @access  Admin only
 */
export const getUserById = async (req, res, next) => {
  try {
    const user = await userService.getUserById(req.params.id);
    return sendSuccess(res, 200, 'User retrieved successfully.', user);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PUT /api/v1/users/:id
 * @access  Admin only
 * @body    { fullName?, phone?, roleName? }
 */
export const updateUser = async (req, res, next) => {
  try {
    const { roleName, ...updates } = req.body;
    const user = await userService.updateUser({
      userId:          req.params.id,
      updates,
      newRoleName:     roleName,
      updatedByUserId: req.userId,
      ipAddress:       req.ip,
    });
    return sendSuccess(res, 200, 'User updated successfully.', user);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PATCH /api/v1/users/:id/deactivate
 * @access  Admin only
 */
export const deactivateUser = async (req, res, next) => {
  try {
    await userService.deactivateUser({
      targetUserId:    req.params.id,
      requestingUserId: req.userId,
      ipAddress:       req.ip,
    });
    return sendSuccess(res, 200, 'User account deactivated successfully.');
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PATCH /api/v1/users/:id/activate
 * @access  Admin only
 */
export const activateUser = async (req, res, next) => {
  try {
    await userService.activateUser({
      targetUserId:     req.params.id,
      requestingUserId: req.userId,
      ipAddress:        req.ip,
    });
    return sendSuccess(res, 200, 'User account activated successfully.');
  } catch (error) {
    next(error);
  }
};

export default {
  createUser,
  listUsers,
  getUserById,
  updateUser,
  deactivateUser,
  activateUser,
};
