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
import { ActivityEventType, Roles, StaffRoles } from '../constants/appConstants.js';
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
    roles: [role._id],      // KAN-93
    roleNames: [role.name], // KAN-93
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
  // KAN-94: `roles` (comma-separated) matches ANY of the user's roles.
  if (query.roles) {
    const roleList = String(query.roles).split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
    if (roleList.length) filter.roleNames = { $in: roleList };
  }
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
      .populate('roles', 'name description permissions')   // KAN-93
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
    .populate('roles', 'name description permissions')   // KAN-93
    .select('-password -passwordResetToken -failedLoginAttempts -lockedUntil')
    .lean();

  if (!user) throw new AppError(MSG.MSG17.message, 404, MSG.MSG17.code);
  return user;
};

/**
 * Lists the roles an Admin can assign to a staff account (KAN-93).
 * CUSTOMER is excluded — customer accounts are self-registered and are never
 * managed through the staff management screens.
 *
 * @returns {Promise<Array<{_id, name, description, permissions}>>}
 */
export const getAssignableRoles = async () => {
  const roles = await Role.find({ name: { $in: StaffRoles }, isActive: true })
    .select('name description permissions')
    .sort({ name: 1 })
    .lean();
  return roles;
};

/**
 * Replaces the full set of roles of a staff user (KAN-93).
 *
 * Rules enforced here:
 * - At least one role is required.
 * - Every role id must exist and be active.
 * - CUSTOMER cannot be mixed with staff roles, and cannot be assigned to a
 *   staff account (customers are self-registered, never managed here).
 *
 * The first role of the input array becomes the primary role
 * (mirrored into `role` / `roleName` for backward compatibility), and the
 * user's tokenVersion is bumped so older JWTs carrying the previous role
 * set are revoked immediately.
 *
 * @param {object} params
 * @param {string} params.userId           - Target user.
 * @param {string[]} params.roleIds        - Array of Role ObjectId strings.
 * @param {string} params.updatedByUserId  - Admin performing the change.
 * @param {string} [params.ipAddress]
 * @returns {Promise<object>} Updated user (safe, no password).
 */
export const updateUserRoles = async ({ userId, roleIds, updatedByUserId, ipAddress }) => {
  const user = await User.findById(userId).select('+tokenVersion');
  if (!user) throw new AppError(MSG.MSG17.message, 404, MSG.MSG17.code);

  if (!Array.isArray(roleIds) || roleIds.length === 0) {
    throw new AppError('At least one role is required.', 400, 'VALIDATION_ERROR');
  }

  // De-duplicate while preserving the caller's order (first = primary).
  const uniqueIds = [...new Set(roleIds.map(String))];

  const roles = await Role.find({ _id: { $in: uniqueIds }, isActive: true });
  if (roles.length !== uniqueIds.length) {
    throw new AppError('One or more role IDs are invalid or inactive.', 400, 'VALIDATION_ERROR');
  }
  // Keep the original request order (find() does not preserve $in order).
  const byId = new Map(roles.map((r) => [r._id.toString(), r]));
  const orderedRoles = uniqueIds.map((id) => byId.get(id));
  const roleNames = orderedRoles.map((r) => r.name);

  const hasCustomer = roleNames.includes(Roles.CUSTOMER);
  const hasStaff    = roleNames.some((n) => n !== Roles.CUSTOMER);

  if (hasCustomer && hasStaff) {
    throw new AppError('Cannot mix CUSTOMER with staff roles.', 409, 'CONFLICT');
  }
  if (hasCustomer && user.roleName !== Roles.CUSTOMER) {
    throw new AppError('Cannot assign CUSTOMER role to a staff account.', 409, 'CONFLICT');
  }
  if (!hasCustomer && user.roleName === Roles.CUSTOMER) {
    throw new AppError('The role of a customer account cannot be changed.', MSG.MSG42.httpStatus, MSG.MSG42.code);
  }

  const beforeRoles = user.roleNames?.length ? [...user.roleNames] : (user.roleName ? [user.roleName] : []);

  user.roles     = orderedRoles.map((r) => r._id);
  user.roleNames = roleNames;
  user.role      = orderedRoles[0]._id;
  user.roleName  = roleNames[0];
  user.updatedBy = updatedByUserId;
  // Revoke every session so the new role set applies immediately.
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;

  await user.save();

  await ActivityLog.log({
    eventType: ActivityEventType.USER_ROLE_CHANGED,
    performedBy: updatedByUserId,
    targetModel: 'User',
    targetId: user._id,
    changes: { before: { roleNames: beforeRoles }, after: { roleNames } },
    summary: `Roles updated for ${user.email}: [${roleNames.join(', ')}]`,
    ipAddress,
  });

  return user.toSafeObject();
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
  const user = await User.findById(userId).select('+tokenVersion');
  if (!user) throw new AppError(MSG.MSG17.message, 404, MSG.MSG17.code);

  const before = { fullName: user.fullName, phone: user.phone, roleName: user.roleName };

  // Apply simple field updates
  if (updates.fullName !== undefined) user.fullName = updates.fullName;
  if (updates.phone !== undefined) user.phone = updates.phone;
  if (updates.avatar !== undefined) user.avatar = updates.avatar;

  // Customer accounts are self-registered; they can never be turned into staff.
  if (newRoleName && user.roleName === Roles.CUSTOMER) {
    throw new AppError(
      'The role of a customer account cannot be changed.',
      MSG.MSG42.httpStatus,
      MSG.MSG42.code
    );
  }

  // Role change (Admin only – enforced at route level, GBR-03)
  if (newRoleName && newRoleName !== user.roleName) {
    const newRole = await resolveRole(newRoleName);
    user.role = newRole._id;
    user.roleName = newRole.name;
    // KAN-93: keep the multi-role fields in sync — a legacy single-role change
    // replaces the whole set with just the new role.
    user.roles = [newRole._id];
    user.roleNames = [newRole.name];
    // The current token still carries the old permissions until it expires.
    // Bumping tokenVersion revokes every session so the new role applies now.
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
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

// ════════════════════════════════════════════════════════════════════════════
// KAN-101 — Reset / Lock / Unlock
// ════════════════════════════════════════════════════════════════════════════

const ADMIN_LOCK_SENTINEL = new Date('2099-12-31T00:00:00.000Z');

/**
 * Generates a strong random password without characters that are easily confused
 * in email (0/O, l/1). 12 characters, mixed case, digits and a few safe symbols.
 */
const generateRandomPassword = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$';
  // crypto is available in Node ≥ 18 as global; fall back to Math.random in tests
  // where the subset of Node might lack webcrypto. Either way we have >= 70 bits.
  const bytes = globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint8Array(12))
    : Array.from({ length: 12 }, () => Math.floor(Math.random() * 256));
  let out = '';
  for (let i = 0; i < 12; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
};

/**
 * Admin-driven password reset. Generates a random password, emails it to the
 * user, revokes all existing sessions. Never returns the password in the API
 * response — it is only ever delivered by email (reduces leak surface via
 * browser history / logs).
 */
export const resetUserPassword = async ({
  targetUserId, requestingUserId, reason, ipAddress,
}) => {
  if (String(targetUserId) === String(requestingUserId)) {
    throw new AppError(
      MSG.MSG_CANNOT_MODIFY_SELF.message,
      MSG.MSG_CANNOT_MODIFY_SELF.httpStatus,
      MSG.MSG_CANNOT_MODIFY_SELF.code,
    );
  }

  const user = await User.findById(targetUserId).select('+password +tokenVersion');
  if (!user) {
    throw new AppError(MSG.MSG17.message, MSG.MSG17.httpStatus, MSG.MSG17.code);
  }

  const newPassword = generateRandomPassword();
  user.password     = newPassword;                          // pre-save hook hashes it
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;         // kick every session
  await user.save();                                        // run validators (password strength)

  // Email delivery is best-effort: if the mailer fails we still return success
  // so the admin knows the password was rotated. The ActivityLog carries the
  // email-delivery flag so support can tell why a user is confused later.
  let emailDelivered = false;
  try {
    const { sendMail } = await import('../config/mailer.js');
    await sendMail({
      to:       user.email,
      toName:   user.fullName || '',
      subject:  'TrustCar — Mật khẩu của bạn đã được quản trị viên đặt lại',
      html: `
        <p>Xin chào ${user.fullName || user.email},</p>
        <p>Quản trị viên vừa đặt lại mật khẩu cho tài khoản <strong>${user.email}</strong>.</p>
        <p>Mật khẩu tạm thời: <code style="font-family:monospace;font-size:16px">${newPassword}</code></p>
        <p>Vui lòng đăng nhập và đổi mật khẩu ngay sau khi vào hệ thống.</p>
        <p>Nếu bạn không yêu cầu thao tác này, hãy liên hệ quản trị viên ngay lập tức.</p>
      `,
      text: `Mật khẩu tạm thời cho ${user.email}: ${newPassword}\nHãy đổi mật khẩu sau khi đăng nhập.`,
    });
    emailDelivered = true;
  } catch (err) {
    // Non-fatal — audit entry below will record delivery failure.
    // eslint-disable-next-line no-console
    console.error('[KAN-101] password reset email failed:', err.message);
  }

  await ActivityLog.log({
    eventType:   ActivityEventType.USER_PASSWORD_RESET,
    performedBy: requestingUserId,
    targetModel: 'User',
    targetId:    user._id,
    summary:     `Admin reset password for ${user.email}`,
    ipAddress,
    metadata:    { reason: reason || null, emailDelivered, sentTo: user.email },
  });

  return { emailSent: emailDelivered, sentTo: user.email };
};

/**
 * KAN-101 — locks a staff account until an admin unlocks it. Bumps tokenVersion
 * so any session held by the user is dropped immediately.
 */
export const lockUser = async ({
  targetUserId, requestingUserId, reason, ipAddress,
}) => {
  if (String(targetUserId) === String(requestingUserId)) {
    throw new AppError(
      MSG.MSG_CANNOT_MODIFY_SELF.message,
      MSG.MSG_CANNOT_MODIFY_SELF.httpStatus,
      MSG.MSG_CANNOT_MODIFY_SELF.code,
    );
  }

  const user = await User.findById(targetUserId).select('+tokenVersion');
  if (!user) {
    throw new AppError(MSG.MSG17.message, MSG.MSG17.httpStatus, MSG.MSG17.code);
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(
      MSG.MSG_ALREADY_LOCKED.message,
      MSG.MSG_ALREADY_LOCKED.httpStatus,
      MSG.MSG_ALREADY_LOCKED.code,
    );
  }

  // Refuse to lock the only active admin — the system would become unreachable.
  if (user.roleName === Roles.ADMIN) {
    const otherAdmins = await User.countDocuments({
      _id: { $ne: user._id },
      roleName: Roles.ADMIN,
      isActive: true,
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date() } }],
    });
    if (otherAdmins === 0) {
      throw new AppError(
        MSG.MSG_LAST_ADMIN.message,
        MSG.MSG_LAST_ADMIN.httpStatus,
        MSG.MSG_LAST_ADMIN.code,
      );
    }
  }

  user.lockedUntil  = ADMIN_LOCK_SENTINEL;
  user.lockedReason = 'ADMIN_LOCK';
  user.lockedBy     = requestingUserId;
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save({ validateBeforeSave: false });

  await ActivityLog.log({
    eventType:   ActivityEventType.USER_LOCKED,
    performedBy: requestingUserId,
    targetModel: 'User',
    targetId:    user._id,
    summary:     `Account locked for ${user.email}`,
    ipAddress,
    metadata:    { reason: reason || null, lockedReason: 'ADMIN_LOCK' },
  });

  return {
    _id:          user._id,
    email:        user.email,
    isLocked:     true,
    lockedReason: user.lockedReason,
    lockedUntil:  user.lockedUntil,
  };
};

/**
 * KAN-101 — clears any lock (admin or auto) and resets the failure counter on
 * the user document. Separate ActivityLog entry so the audit trail is explicit.
 */
export const unlockUser = async ({
  targetUserId, requestingUserId, reason, ipAddress,
}) => {
  const user = await User.findById(targetUserId);
  if (!user) {
    throw new AppError(MSG.MSG17.message, MSG.MSG17.httpStatus, MSG.MSG17.code);
  }

  if (!user.lockedUntil || user.lockedUntil <= new Date()) {
    throw new AppError(
      MSG.MSG_NOT_LOCKED.message,
      MSG.MSG_NOT_LOCKED.httpStatus,
      MSG.MSG_NOT_LOCKED.code,
    );
  }

  const previousReason = user.lockedReason;
  user.lockedUntil         = null;
  user.lockedReason        = null;
  user.lockedBy            = null;
  user.failedLoginAttempts = 0;
  await user.save({ validateBeforeSave: false });

  await ActivityLog.log({
    eventType:   ActivityEventType.USER_UNLOCKED,
    performedBy: requestingUserId,
    targetModel: 'User',
    targetId:    user._id,
    summary:     `Account unlocked for ${user.email}`,
    ipAddress,
    metadata:    { reason: reason || null, previousLockedReason: previousReason },
  });

  return {
    _id:      user._id,
    email:    user.email,
    isLocked: false,
  };
};

export default {
  createUser,
  getUsers,
  getUserById,
  getAssignableRoles,
  updateUser,
  updateUserRoles,   // KAN-93
  deactivateUser,
  activateUser,
  resetUserPassword, // KAN-101
  lockUser,          // KAN-101
  unlockUser,        // KAN-101
};
