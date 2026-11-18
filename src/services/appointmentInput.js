/**
 * @file appointmentInput.js
 * @description Small pure input helpers shared by the appointment services:
 * free-text normalisation (reason / outcome), reserved-value protection and
 * visit pagination.
 *
 * `cancellationReason` carries machine markers (`AUTO_CAR_UNAVAILABLE:…`, `RACE_LOST`,
 * `BOOKING_ABORTED`). A person must never be able to forge one, or a customer's own
 * cancellation could be shown as "car no longer available".
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-004, REQ-016, REQ-019, C10, C11)
 */

import { SystemMessages as MSG } from '../constants/systemMessages.js';
import {
  REASON_MAX_LENGTH, OUTCOME_MAX_LENGTH, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE,
  CANCEL_NOTE_MAX, CancelReasonCode,
} from '../constants/appointmentRules.js';
import { buildPaginationMeta } from '../utils/apiResponse.js';
import { fail } from './appointmentErrors.js';
import { encodeStaffReason, isForbiddenForUser, isReasonCode } from './appointmentCancelReason.js';

/** 422 VALIDATION_ERROR with a single `{ field, message }` detail. */
export const invalid = (field, message) => fail(MSG.MSG42, [{ field, message }]);

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * A CUSTOMER's cancellation reason: trimmed, or null when empty. Throws 422 when
 * required-but-empty, too long, or shaped like a system / staff value (C22).
 */
export const normalizeReason = (reason, { required = false } = {}) => {
  const text = clean(reason);
  if (!text) {
    if (required) throw invalid('reason', 'reason is required.');
    return null;
  }
  if (text.length > REASON_MAX_LENGTH) throw invalid('reason', `reason must not exceed ${REASON_MAX_LENGTH} characters.`);
  if (isForbiddenForUser(text)) throw invalid('reason', 'reason uses a reserved value.');
  return text;
};

/**
 * What to store when STAFF cancel a visit (C20): `<CODE>|<internal note>`.
 * Without `reasonCode` (Spec 1.0.0 clients) the code is OTHER and a note is mandatory.
 *
 * @returns {string} The `cancellationReason` to store.
 */
export const normalizeStaffCancel = ({ reasonCode, reason }) => {
  const code = reasonCode ?? CancelReasonCode.OTHER;
  if (!isReasonCode(code)) throw invalid('reasonCode', 'reasonCode is not one of the allowed values.');
  const note = clean(reason);
  if (note.length > CANCEL_NOTE_MAX) throw invalid('reason', `reason must not exceed ${CANCEL_NOTE_MAX} characters.`);
  if (code === CancelReasonCode.OTHER && !note) throw invalid('reason', 'reason is required.');
  return encodeStaffReason(code, note);
};

/** Trimmed outcome note, or null when empty. */
export const normalizeOutcome = (outcome) => {
  const text = clean(outcome);
  if (!text) return null;
  if (text.length > OUTCOME_MAX_LENGTH) throw invalid('outcome', `outcome must not exceed ${OUTCOME_MAX_LENGTH} characters.`);
  return text;
};

/** Page `{ page, limit }` from query values: default 10, at most 50 visits per page. */
export const pagingOf = (query = {}) => ({
  page: Math.max(1, parseInt(query.page, 10) || 1),
  limit: Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.limit, 10) || DEFAULT_PAGE_SIZE)),
});

/** Cuts one page out of an array of visits. Returns `{ items, pagination }`. */
export const paginateVisits = (visits, query) => {
  const { page, limit } = pagingOf(query);
  const start = (page - 1) * limit;
  return { items: visits.slice(start, start + limit), pagination: buildPaginationMeta(visits.length, page, limit) };
};
