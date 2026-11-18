/**
 * @file appointmentCancelReason.js
 * @description Pure helpers for `cancellationReason`, the one text column that carries
 * three different things (no schema change, Spec C20–C22):
 *
 *   - a customer's own free text                        e.g. "bận việc"
 *   - a staff choice  `<REASON_CODE>|<internal note>`   e.g. "SHOWROOM_BUSY|gọi 2 lần"
 *   - a system marker `AUTO_CAR_UNAVAILABLE:…`, `RESCHEDULED:…`, `RACE_LOST`, `BOOKING_ABORTED`
 *
 * What the customer (and the e-mail) may read about a staff cancellation is ONLY the
 * label of the code. The note after `|` is internal. A person must never be able to
 * forge a staff or system value through the customer's free-text field.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-020, REQ-030, C20–C22, INV-13)
 */

import {
  AUTO_CANCEL_PREFIX, RACE_LOST_REASON, ABORTED_REASON, RESCHEDULED_PREFIX,
  CancelReasonCode, CANCEL_REASON_LABELS,
} from '../constants/appointmentRules.js';

const SEPARATOR = '|';
const CODES = Object.values(CancelReasonCode);

/** `<CODE>|<note>`; the note may be empty and may itself contain `|`. */
export const encodeStaffReason = (code, note) => `${code}${SEPARATOR}${note ?? ''}`;

/**
 * @param {*} text A stored `cancellationReason`.
 * @returns {{ code: string, label: string, note: string|null } | null} null unless it is a staff value.
 */
export const parseStaffReason = (text) => {
  if (typeof text !== 'string') return null;
  const at = text.indexOf(SEPARATOR);
  if (at < 0) return null;
  const code = text.slice(0, at);
  if (!CODES.includes(code)) return null;
  const note = text.slice(at + 1).trim();
  return { code, label: CANCEL_REASON_LABELS[code], note: note || null };
};

/** Customer-facing label of a reason code, or null for an unknown code. */
export const labelOf = (code) => CANCEL_REASON_LABELS[code] ?? null;

export const isReasonCode = (value) => CODES.includes(value);

/** True for markers only the system may write. */
export const isSystemMarker = (text) =>
  text.startsWith(AUTO_CANCEL_PREFIX)
  || text.startsWith(RESCHEDULED_PREFIX)
  || text === RACE_LOST_REASON
  || text === ABORTED_REASON;

/** Text a CUSTOMER must not be allowed to store: system markers and staff-shaped values. */
export const isForbiddenForUser = (text) => isSystemMarker(text) || parseStaffReason(text) !== null;

export default { encodeStaffReason, parseStaffReason, labelOf, isReasonCode, isSystemMarker, isForbiddenForUser };
