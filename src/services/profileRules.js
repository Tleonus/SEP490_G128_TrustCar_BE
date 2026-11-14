/**
 * @file profileRules.js
 * @description Pure rules of the profile feature (no database): which fields a role may edit,
 * what an edit really changes, and how a date of birth is stored.
 *
 * Why it is separate from the service: the decisions here are the part most likely to be wrong
 * (a field a staff member must not set, a no-op that must not write, a date shifted by a time
 * zone), and pure functions are the cheapest thing to test exhaustively.
 *
 * Ref: .sdd/features/user-profile-settings/SPEC.md (C3, C6, C9–C11, C17; REQ-005, 006, 011)
 */

import { Roles } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { AppError } from '../utils/apiResponse.js';

export const CUSTOMER_EDITABLE = Object.freeze(['fullName', 'phone', 'address', 'dateOfBirth', 'gender']);
export const STAFF_EDITABLE = Object.freeze(['fullName', 'phone']);
export const ADDRESS_KEYS = Object.freeze(['street', 'district', 'city', 'province']);

const VN_OFFSET_MS = 7 * 3600 * 1000; // Vietnam has no daylight saving time
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The fields a role may change (customers: contact + extended fields; staff: name and phone). */
export const editableFieldsFor = (roleName) => [...(roleName === Roles.CUSTOMER ? CUSTOMER_EDITABLE : STAFF_EDITABLE)];

/**
 * REQ-006: a staff member may not send the customer-only fields.
 *
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-006
 * @throws {AppError} 422 VALIDATION_ERROR listing every field that is not allowed for the role.
 */
export const assertEditable = (roleName, body) => {
  const allowed = new Set(editableFieldsFor(roleName));
  const denied = Object.keys(body ?? {}).filter((key) => !allowed.has(key));
  if (denied.length === 0) return;
  throw new AppError(MSG.MSG42.message, MSG.MSG42.httpStatus, MSG.MSG42.code,
    denied.map((field) => ({ field, message: `${field} cannot be changed by this account.` })));
};

/** `YYYY-MM-DD` that is a real calendar day (rejects `2000-02-31`). */
export const isRealDateKey = (value) => {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** Stored form of a date of birth: 00:00 UTC of that calendar day (SPEC C10, NFR-03). */
export const dobToStored = (dateKey) => (dateKey == null ? null : new Date(`${dateKey}T00:00:00.000Z`));

/** The `YYYY-MM-DD` the customer typed, whatever time zone the server runs in. */
export const dobFromStored = (value) => (value ? new Date(value).toISOString().slice(0, 10) : null);

/** Today's date in Vietnam as `YYYY-MM-DD` (a birth date must not be after it). */
export const todayInVietnam = (now = new Date()) => new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);

/** `""` and `null` clear a field; anything else is kept as sent (already trimmed by Joi). */
const clearable = (value) => (value === '' || value === undefined ? null : value);

const addressPatch = (patchAddress, currentAddress, customerFields) => {
  let changed = false;
  for (const key of ADDRESS_KEYS) {
    if (!(key in (patchAddress ?? {}))) continue; // only the sub-fields that were sent (C9)
    const next = clearable(patchAddress[key]);
    if (next !== (currentAddress?.[key] ?? null)) {
      customerFields[`address.${key}`] = next;
      changed = true;
    }
  }
  return changed;
};

/**
 * What a PATCH really changes, field by field, against both stored records.
 *
 * `current` = `{ user: { fullName, phone }, customer: { fullName, phone, address, dateOfBirth, gender } | null }`
 * with `dateOfBirth` already as `YYYY-MM-DD`. A field counts as changed when it differs from the
 * User **or** from the Customer, and is then written to the record(s) that differ, so the two
 * stay equal (REQ-008) even if a showroom-created Customer had drifted. Sending the value that is
 * already stored changes nothing (C17).
 *
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-011
 * @returns {{ userFields: object, customerFields: object, changed: string[] }}
 */
export const diffProfile = (current, patch) => {
  const { user, customer } = current;
  const userFields = {};
  const customerFields = {};
  const changed = [];

  for (const key of ['fullName', 'phone']) {
    if (patch[key] === undefined) continue;
    const userDiffers = patch[key] !== user[key];
    const customerDiffers = customer !== null && patch[key] !== customer[key];
    if (userDiffers) userFields[key] = patch[key];
    if (customerDiffers) customerFields[key] = patch[key];
    if (userDiffers || customerDiffers) changed.push(key);
  }

  if (customer !== null) {
    if (patch.address !== undefined && addressPatch(patch.address, customer.address, customerFields)) changed.push('address');
    if (patch.dateOfBirth !== undefined && patch.dateOfBirth !== (customer.dateOfBirth ?? null)) {
      customerFields.dateOfBirth = dobToStored(patch.dateOfBirth);
      changed.push('dateOfBirth');
    }
    if (patch.gender !== undefined && patch.gender !== (customer.gender ?? null)) {
      customerFields.gender = patch.gender;
      changed.push('gender');
    }
  }
  return { userFields, customerFields, changed };
};

export default {
  editableFieldsFor, assertEditable, isRealDateKey, dobToStored, dobFromStored, todayInVietnam, diffProfile,
};
