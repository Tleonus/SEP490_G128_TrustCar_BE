/**
 * @file profileMapper.js
 * @description Turns the stored `User` / `Customer` into the profile DTOs the API returns.
 *
 * WHITELIST, never a spread: every key of the output is written out below, so a field added to
 * the models later (a token counter, an internal note…) can never leak through the profile API
 * by accident. Password, tokens, firebase id, login-failure fields, avatar and the CRM-internal
 * fields of `Customer` are deliberately not here (REQ-003).
 *
 * Ref: .sdd/features/user-profile-settings/SPEC.md (section 5; REQ-002, 003, 012)
 */

import { Roles } from '../constants/appConstants.js';
import { ADDRESS_KEYS, dobFromStored, editableFieldsFor } from './profileRules.js';

const idOf = (value) => (value == null ? null : String(value));

const addressOf = (customer) =>
  Object.fromEntries(ADDRESS_KEYS.map((key) => [key, customer?.address?.[key] ?? null]));

/**
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-002
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-003
 * @param {object} user      Lean `User`.
 * @param {object|null} customer  Lean `Customer` of a customer account, `null` for staff.
 */
export const toProfileDto = (user, customer) => {
  const isCustomer = user.roleName === Roles.CUSTOMER;
  return {
    id: idOf(user._id),
    email: user.email,
    role: user.roleName,
    fullName: user.fullName ?? null,
    phone: user.phone ?? null,
    address: isCustomer ? addressOf(customer) : null,
    dateOfBirth: isCustomer ? dobFromStored(customer?.dateOfBirth) : null,
    gender: isCustomer ? (customer?.gender ?? null) : null,
    editableFields: editableFieldsFor(user.roleName),
    createdAt: user.createdAt ?? null,
  };
};

/**
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-012
 * @param {object|null} customer Lean `Customer`.
 */
export const toSettingsDto = (customer) => ({ marketingConsent: customer?.marketingConsent === true });

export default { toProfileDto, toSettingsDto };
