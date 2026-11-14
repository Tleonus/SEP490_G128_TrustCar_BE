/**
 * @file profileService.js
 * @description View and edit the signed-in account's own profile and settings.
 *
 * The account always comes from the token (`userId`); no function takes another account's id,
 * so there is nothing to forge (REQ-016). Everything that decides WHAT changes is in the pure
 * `profileRules.js`; what reaches the response is whitelisted by `profileMapper.js`.
 *
 * Ref: .sdd/features/user-profile-settings/SPEC.md (REQ-001…018)
 */

import User from '../models/User.js';
import Customer from '../models/Customer.js';
import ActivityLog from '../models/ActivityLog.js';
import { ActivityEventType, Roles } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { appError } from './customerRegistrationService.js';
import { assertEditable, diffProfile, dobFromStored } from './profileRules.js';
import { toProfileDto, toSettingsDto } from './profileMapper.js';
import { writeProfile } from './profileWrite.js';

const USER_FIELDS = 'fullName phone email roleName customer createdAt';

/**
 * The account in the token and, for a customer, the linked Customer.
 * @throws {AppError} 404 USER_NOT_FOUND / CUSTOMER_NOT_FOUND
 */
const loadAccount = async (userId) => {
  const user = await User.findById(userId).select(USER_FIELDS).lean();
  if (!user) throw appError(MSG.MSG17);
  if (user.roleName !== Roles.CUSTOMER) return { user, customer: null };
  const customer = user.customer ? await Customer.findById(user.customer).lean() : null;
  if (!customer) throw appError(MSG.MSG31);
  return { user, customer };
};

const requireCustomer = (user) => {
  if (user.roleName !== Roles.CUSTOMER) throw appError(MSG.MSG05);
};

/** What the diff compares against: both stored records, the birth date as `YYYY-MM-DD`. */
const currentOf = ({ user, customer }) => ({
  user: { fullName: user.fullName, phone: user.phone },
  customer: customer && {
    fullName: customer.fullName,
    phone: customer.phone,
    address: customer.address,
    dateOfBirth: dobFromStored(customer.dateOfBirth),
    gender: customer.gender ?? null,
  },
});

const record = ({ eventType, user, summary, ipAddress, userAgent }) => ActivityLog.log({
  eventType,
  performedBy: user._id,
  performedByEmail: user.email,
  targetModel: 'User',
  targetId: user._id,
  summary, // field NAMES only, never values (personal data)
  ipAddress,
  userAgent,
});

/** @ears .sdd/features/user-profile-settings/SPEC.md#REQ-002 */
export const getProfile = async (userId) => {
  const { user, customer } = await loadAccount(userId);
  return toProfileDto(user, customer);
};

/** @ears .sdd/features/user-profile-settings/SPEC.md#REQ-012 */
export const getSettings = async (userId) => {
  const { user, customer } = await loadAccount(userId);
  requireCustomer(user);
  return toSettingsDto(customer);
};

/**
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-004
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-007
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-017
 * @param {{ userId: *, body: object, ipAddress?: string, userAgent?: string }} p  `body` already passed Joi.
 * @returns {Promise<object>} The profile DTO after the change (the current one when nothing changed, C17).
 */
export const updateProfile = async ({ userId, body, ipAddress, userAgent }) => {
  const account = await loadAccount(userId);
  const { user, customer } = account;
  assertEditable(user.roleName, body);

  const diff = diffProfile(currentOf(account), body);
  if (diff.changed.length === 0) return toProfileDto(user, customer);

  // Early, friendly refusal; the unique index on User still decides a real race (REQ-010).
  if (diff.userFields.phone && await User.exists({ roleName: Roles.CUSTOMER, phone: diff.userFields.phone, _id: { $ne: user._id } })) {
    throw appError(MSG.MSG69);
  }
  await writeProfile({ user, customer, diff, actorId: user._id });
  await record({
    eventType: ActivityEventType.PROFILE_UPDATED, user, summary: `Profile updated: ${diff.changed.join(', ')}`, ipAddress, userAgent,
  });
  return getProfile(userId);
};

/**
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-013
 * @param {{ userId: *, body: { marketingConsent: boolean }, ipAddress?: string, userAgent?: string }} p
 */
export const updateSettings = async ({ userId, body, ipAddress, userAgent }) => {
  const { user, customer } = await loadAccount(userId);
  requireCustomer(user);
  if (body.marketingConsent === (customer.marketingConsent === true)) return toSettingsDto(customer);

  const result = await Customer.updateOne({ _id: customer._id }, { $set: { marketingConsent: body.marketingConsent, updatedBy: user._id } });
  if (result.matchedCount === 0) throw appError(MSG.MSG31);
  await record({
    eventType: ActivityEventType.SETTINGS_UPDATED, user, summary: 'Settings updated: marketingConsent', ipAddress, userAgent,
  });
  return { marketingConsent: body.marketingConsent };
};

export default { getProfile, getSettings, updateProfile, updateSettings };
