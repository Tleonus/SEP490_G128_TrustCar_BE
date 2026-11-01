/**
 * @file roleMiddleware.js
 * @description Role-Based Access Control (RBAC) middleware.
 *
 * Implements the Chain of Responsibility pattern to enforce granular permission
 * checks after JWT authentication (authMiddleware.js) has confirmed identity.
 *
 * Exports:
 * - requirePermission(...permissions): Returns middleware checking that req.user
 *   holds AT LEAST ONE of the specified permissions.
 * - requireRole(...roles): Returns middleware checking that req.user's role
 *   matches one of the specified role names.
 * - requireAdmin: Shorthand for requireRole(Roles.ADMIN).
 *
 * Ref: GBR-02, GBR-03
 */

import { Roles, ROLE_PERMISSIONS } from '../constants/appConstants.js';
import { AppError } from '../utils/apiResponse.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';

/**
 * Returns an Express middleware that verifies the authenticated user holds
 * AT LEAST ONE of the specified permissions.
 *
 * Usage:
 *   router.post('/cars', verifyToken, requirePermission('car:create'), carController.create);
 *
 * @param {...string} permissions - One or more permission strings from appConstants.Permissions.
 * @returns {import('express').RequestHandler}
 *
 * Ref: GBR-02
 */
export const requirePermission = (...permissions) => {
  return (req, _res, next) => {
    if (!req.user) {
      // verifyToken should always run first; this is a safeguard
      return next(new AppError(MSG.MSG01.message, 401, MSG.MSG01.code));
    }

    const userRole        = req.user.roleName;
    const userPermissions = ROLE_PERMISSIONS[userRole] || [];

    const hasPermission = permissions.some((p) => userPermissions.includes(p));

    if (!hasPermission) {
      return next(
        new AppError(
          `${MSG.MSG04.message} Required: [${permissions.join(' | ')}]`,
          MSG.MSG04.httpStatus,
          MSG.MSG04.code
        )
      );
    }

    next();
  };
};

/**
 * Returns an Express middleware that verifies the authenticated user's role
 * matches one of the specified role names (exact match).
 *
 * Usage:
 *   router.get('/users', verifyToken, requireRole('ADMIN'), userController.list);
 *
 * @param {...string} roles - One or more role names from appConstants.Roles.
 * @returns {import('express').RequestHandler}
 *
 * Ref: GBR-02, GBR-03
 */
export const requireRole = (...roles) => {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError(MSG.MSG01.message, 401, MSG.MSG01.code));
    }

    if (!roles.includes(req.user.roleName)) {
      return next(
        new AppError(
          `${MSG.MSG05.message} Required role(s): [${roles.join(' | ')}]`,
          MSG.MSG05.httpStatus,
          MSG.MSG05.code
        )
      );
    }

    next();
  };
};

/**
 * Shorthand: Requires the ADMIN role.
 * Ref: GBR-03
 */
export const requireAdmin = requireRole(Roles.ADMIN);

/**
 * Middleware that allows the request if the user is the resource owner
 * (req.userId === paramId) OR the user is an Admin.
 * Useful for "own profile only" endpoints (GBR-23).
 *
 * @param {string} [paramName='id'] - The route parameter name containing the target user ID.
 */
export const requireOwnerOrAdmin = (paramName = 'id') => {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError(MSG.MSG01.message, 401, MSG.MSG01.code));
    }

    const isAdmin    = req.user.roleName === Roles.ADMIN;
    const isOwner    = req.userId === req.params[paramName];

    if (!isAdmin && !isOwner) {
      return next(new AppError(MSG.MSG04.message, MSG.MSG04.httpStatus, MSG.MSG04.code));
    }

    next();
  };
};

export const authorizeRoles = (...allowedRoles) => {
  return (req, _res, next) => {
    if (!req.user) {
      // Should have passed verifyToken first
      return next(new AppError('Token missing or invalid', 401, 'UNAUTHORIZED'));
    }
    const userRole = req.user.roleName || (typeof req.user.role === 'object' ? req.user.role?.name : req.user.role);
    if (!allowedRoles.includes(userRole)) {
      return next(new AppError('Access denied: insufficient permissions', 403, 'FORBIDDEN'));
    }
    next();
  };
};

export const restrictTo = (...roles) => authorizeRoles(...roles);

export default { requirePermission, requireRole, requireAdmin, requireOwnerOrAdmin, authorizeRoles, restrictTo };
