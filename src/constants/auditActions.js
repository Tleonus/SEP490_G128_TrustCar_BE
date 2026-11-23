/**
 * @file auditActions.js
 * @description KAN-92: groups every activity-log event type into the coarse "action" an admin filters by
 * (CREATE / UPDATE / DELETE / STATUS_CHANGE / AUTH / OTHER). The log stores only `eventType`; the action is
 * DERIVED from it, so old entries are classified too and no migration is needed.
 */

import { ActivityEventType as E } from './appConstants.js';

export const AuditAction = Object.freeze({
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  STATUS_CHANGE: 'STATUS_CHANGE',
  AUTH: 'AUTH',
  OTHER: 'OTHER',
});

/** Explicit groups. Any event type not listed here (e.g. CAR_PUBLISHED_FACEBOOK, PRICE_ALERT_SENT) is OTHER. */
export const AUDIT_ACTION_GROUPS = Object.freeze({
  [AuditAction.CREATE]: Object.freeze([
    E.CUSTOMER_REGISTERED, E.USER_CREATED, E.CAR_CREATED, E.CAR_IMAGE_ADDED, E.CUSTOMER_CREATED,
    E.LEAD_CREATED, E.LEAD_NOTE_ADDED, E.APPOINTMENT_CREATED, E.INSPECTION_DRAFT_CREATED, E.CAR_SAVED_WISHLIST,
  ]),
  [AuditAction.UPDATE]: Object.freeze([
    E.PROFILE_COMPLETED, E.PROFILE_UPDATED, E.SETTINGS_UPDATED, E.USER_UPDATED, E.CAR_UPDATED,
    E.CAR_PRICE_UPDATED, E.CUSTOMER_UPDATED, E.APPOINTMENT_RESCHEDULED, E.APPOINTMENT_REASSIGNED,
    E.APPOINTMENT_NO_SHOW_CORRECTED, E.WISHLIST_SYNCED,
  ]),
  [AuditAction.DELETE]: Object.freeze([E.CAR_IMAGE_REMOVED, E.CAR_REMOVED_WISHLIST]),
  [AuditAction.STATUS_CHANGE]: Object.freeze([
    E.USER_ACTIVATED, E.USER_DEACTIVATED, E.CAR_STATUS_CHANGED, E.LEAD_STAGE_CHANGED, E.APPOINTMENT_CONFIRMED,
    E.APPOINTMENT_CANCELLED, E.APPOINTMENT_COMPLETED, E.APPOINTMENT_NO_SHOW, E.INSPECTION_SUBMITTED, E.INSPECTION_REJECTED,
  ]),
  [AuditAction.AUTH]: Object.freeze([
    E.USER_LOGIN, E.USER_LOGOUT, E.LOGIN_FAILED, E.ACCOUNT_LOCKED, E.PASSWORD_CHANGED, E.PASSWORD_RESET, E.GOOGLE_LINKED,
  ]),
});

const BY_EVENT = new Map();
for (const [action, types] of Object.entries(AUDIT_ACTION_GROUPS)) {
  for (const type of types) BY_EVENT.set(type, action);
}

/** Action of one event type; unknown or missing types are OTHER (never throws). */
export const actionOf = (eventType) => BY_EVENT.get(eventType) ?? AuditAction.OTHER;

/** Every known event type that belongs to `action` (used to turn `?action=` into an `$in` filter). */
export const eventTypesOf = (action) => Object.values(E).filter((type) => actionOf(type) === action);

/** `{ EVENT_TYPE: ACTION }` for every known event type (sent to the admin screen with the filter meta). */
export const eventActionMap = () => Object.fromEntries(Object.values(E).map((type) => [type, actionOf(type)]));

export default { AuditAction, AUDIT_ACTION_GROUPS, actionOf, eventTypesOf, eventActionMap };
