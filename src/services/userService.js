/**
 * @file userService.js
 * @description Internal staff account provisioning and management.
 *
 * Responsibilities (Admin-only operations – GBR-03):
 * - Create new staff accounts
 * - Paginated staff listing with optional filters
 * - Get single user by ID
 * - Update user profile fields
 * - Toggle account active status (deactivate / reactivate)
 *
 * All database interactions go through Mongoose models directly.
 * Ref: GBR-03, GBR-21, GBR-24, GBR-25
 */

import User from '../models/User.js';
import Role from '../models/Role.js';
import ActivityLog from '../models/ActivityLog.js';
import { AppError } from '../utils/apiResponse.js';
import { parsePagination, buildPaginationMeta } from '../utils/apiResponse.js';
import { ActivityEventType, Roles } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Resolves a Role document by name.
 * @param {string} roleName - e.g., 'ADMIN' | 'SALES_STAFF'
 * @returns {Promise<object>} Role document.
 */
const resolveRole = async (roleName) => {
  const role = await Role.findOne({ name: roleName.toUpperCase(), isActive: true });
  if (!role) {
    throw new AppError(
      `Role "${roleName}" not found or is inactive.`,
      400,
      'ROLE_NOT_FOUND'
    );
  }
  return role;
};

// ════════════════════════════════════════════════════════════════════════════
// SERVICE METHODS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Creates a new internal staff account.
 * Only callable by Admin (enforced at route/middleware level, GBR-03).
 *
 * @param {object} params
 * @param {string} params.fullName
 * @param {string} params.email
 * @param {string} params.password
 * @param {string} params.roleName - 'ADMIN' | 'SALES_STAFF'
 * @param {string} [params.phone]
 * @param {string} params.createdByUserId - The Admin's userId.
 * @param {string} [params.ipAddress]
 * @returns {Promise<object>} Created user (safe, no password).
 */
export const createUser = async ({
  fullName, email, password, roleName, phone, createdByUserId, ipAddress,
}) => {
  // Check email uniqueness
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    throw new AppError(MSG.MSG18.message, MSG.MSG18.httpStatus, MSG.MSG18.code);
  }

  const role = await resolveRole(roleName || Roles.SALES_STAFF);

  const user = await User.create({
    fullName,
    email: email.toLowerCase(),
    password,
    phone,
    role: role._id,
    roleName: role.name,
    createdBy: createdByUserId,
  });

  await ActivityLog.log({
    eventType: ActivityEventType.USER_CREATED,
    performedBy: createdByUserId,
    targetModel: 'User',
    targetId: user._id,
    summary: `New ${role.name} account created for ${email}`,
    ipAddress,
    metadata: { roleName: role.name, email },
  });

  return user.toSafeObject();
};

/**
 * Retrieves a paginated list of all staff accounts.
 *
 * @param {object} query - Express req.query (page, limit, roleName, isActive, search)
 * @returns {Promise<{ items: Array, pagination: object }>}
 */
export const getUsers = async (query) => {
  const { page, limit, skip } = parsePagination(query);

  const filter = {};
  if (query.roleName) filter.roleName = query.roleName.toUpperCase();
  if (query.isActive !== undefined) {
    filter.isActive = query.isActive === 'true' || query.isActive === true;
  }
  if (query.search) {
    filter.$or = [
      { fullName: { $regex: query.search, $options: 'i' } },
      { email: { $regex: query.search, $options: 'i' } },
    ];
  }

  const [items, total] = await Promise.all([
    User.find(filter)
      .populate('role', 'name')
      .select('-password -passwordResetToken -failedLoginAttempts -lockedUntil')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  return { items, pagination: buildPaginationMeta(total, page, limit) };
};

/**
 * Retrieves a single user by MongoDB ObjectId.
 * @param {string} userId
 * @returns {Promise<object>} User document (safe).
 */
export const getUserById = async (userId) => {
  const user = await User.findById(userId)
    .populate('role', 'name permissions')
    .select('-password -passwordResetToken -failedLoginAttempts -lockedUntil')
    .lean();

  if (!user) throw new AppError(MSG.MSG17.message, 404, MSG.MSG17.code);
  return user;
};

/**
 * Updates mutable profile fields for a user (Admin only for other users).
 *
 * @param {object} params
 * @param {string} params.userId         - Target user to update.
 * @param {object} params.updates        - Fields to update (fullName, phone, avatar).
 * @param {string} [params.newRoleName]  - If provided and caller is Admin, changes role.
 * @param {string} params.updatedByUserId
 * @param {string} [params.ipAddress]
 * @returns {Promise<object>} Updated user (safe).
 */
export const updateUser = async ({ userId, updates, newRoleName, updatedByUserId, ipAddress }) => {
  const user = await User.findById(userId);
  if (!user) throw new AppError(MSG.MSG17.message, 404, MSG.MSG17.code);

  const before = { fullName: user.fullName, phone: user.phone, roleName: user.roleName };

  // Apply simple field updates
  if (updates.fullName !== undefined) user.fullName = updates.fullName;
  if (updates.phone !== undefined) user.phone = updates.phone;
  if (updates.avatar !== undefined) user.avatar = updates.avatar;

  // Role change (Admin only – enforced at route level, GBR-03)
  if (newRoleName && newRoleName !== user.roleName) {
    const newRole = await resolveRole(newRoleName);
    user.role = newRole._id;
    user.roleName = newRole.name;
  }

  user.updatedBy = updatedByUserId;
  await user.save();

  await ActivityLog.log({
    eventType: ActivityEventType.USER_UPDATED,
    performedBy: updatedByUserId,
    targetModel: 'User',
    targetId: user._id,
    changes: { before, after: { fullName: user.fullName, phone: user.phone, roleName: user.roleName } },
    summary: `User profile updated for ${user.email}`,
    ipAddress,
  });

  return user.toSafeObject();
};

/**
 * Deactivates an active user account (soft-delete alternative).
 * An Admin cannot deactivate their own account (GBR-03, GBR-25).
 *
 * @param {object} params
 * @param {string} params.targetUserId    - The user to deactivate.
 * @param {string} params.requestingUserId - Must not equal targetUserId (GBR-03).
 * @param {string} [params.ipAddress]
 * @returns {Promise<void>}
 */
export const deactivateUser = async ({ targetUserId, requestingUserId, ipAddress }) => {
  if (targetUserId === requestingUserId) {
    throw new AppError(MSG.MSG16.message, MSG.MSG16.httpStatus, MSG.MSG16.code);
  }

  const user = await User.findById(targetUserId);
  if (!user) throw new AppError(MSG.MSG17.message, 404, MSG.MSG17.code);

  if (!user.isActive) {
    throw new AppError('This account is already inactive.', 409, 'ACCOUNT_ALREADY_INACTIVE');
  }

  user.isActive = false;
  user.updatedBy = requestingUserId;
  await user.save({ validateBeforeSave: false });

  await ActivityLog.log({
    eventType: ActivityEventType.USER_DEACTIVATED,
    performedBy: requestingUserId,
    targetModel: 'User',
    targetId: user._id,
    summary: `Account deactivated for ${user.email}`,
    ipAddress,
  });
};

/**
 * Reactivates a deactivated user account.
 *
 * @param {object} params
 * @param {string} params.targetUserId
 * @param {string} params.requestingUserId
 * @param {string} [params.ipAddress]
 * @returns {Promise<void>}
 */
export const activateUser = async ({ targetUserId, requestingUserId, ipAddress }) => {
  const user = await User.findById(targetUserId);
  if (!user) throw new AppError(MSG.MSG17.message, 404, MSG.MSG17.code);

  if (user.isActive) {
    throw new AppError(MSG.MSG19.message, MSG.MSG19.httpStatus, MSG.MSG19.code);
  }

  user.isActive = true;
  user.updatedBy = requestingUserId;
  // Clear any stale lock on reactivation
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  await user.save({ validateBeforeSave: false });

  await ActivityLog.log({
    eventType: ActivityEventType.USER_ACTIVATED,
    performedBy: requestingUserId,
    targetModel: 'User',
    targetId: user._id,
    summary: `Account reactivated for ${user.email}`,
    ipAddress,
  });
};

export default {
  createUser,
  getUsers,
  getUserById,
  updateUser,
  deactivateUser,
  activateUser,
};
