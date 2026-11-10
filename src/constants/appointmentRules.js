/**
 * @file appointmentRules.js
 * @description Business constants of the test-drive booking feature (visit model).
 * A "visit" = 1..MAX_CARS_PER_VISIT appointments of one customer at one fixed slot.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (section 5, C1–C4)
 */

import { AppointmentStatus } from './appConstants.js';

/** Fixed visit start times, Vietnam local time (UTC+7). Each lasts VISIT_DURATION_MIN. */
export const SLOTS = Object.freeze(['08:00', '10:00', '13:00', '15:00']);

/** Vietnam has no daylight saving time, so a fixed offset is exact. */
export const VN_UTC_OFFSET_HOURS = 7;

export const VISIT_DURATION_MIN = 90;
export const MAX_CARS_PER_VISIT = 3;
export const MAX_OPEN_VISITS_PER_CUSTOMER = 2;
export const MAX_CONCURRENT_VISITS_PER_SLOT = 2;

/** Cancelling less than this many hours before the visit is flagged "late" (soft rule). */
export const LATE_CANCEL_HOURS = 12;
/** Cancelling within this many minutes after booking is never flagged late. */
export const LATE_CANCEL_GRACE_MIN = 30;

export const SLOT_QUERY_MAX_DAYS = 14;
export const NOTES_MAX_LENGTH = 500;
export const REASON_MAX_LENGTH = 500;
export const OUTCOME_MAX_LENGTH = 1000;
export const CODE_RETRY_LIMIT = 3;
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 10;

export const SHOWROOM_LOCATION = 'Showroom TrustCar, Quận 1, TP. Hồ Chí Minh';

// ── 1.1.0: reschedule, staff reminders, staff cancel reasons ──────────────────
/** A customer may reschedule one visit at most this many times (staff are not limited). */
export const MAX_RESCHEDULES_PER_VISIT = 2;
/** A customer may only reschedule online while at least this many hours remain. */
export const SELF_RESCHEDULE_MIN_HOURS = 12;
/** A CONFIRMED visit needs a reminder call from this many minutes before its start. */
export const STAFF_REMINDER_WINDOW_MIN = 30;
/** A CONFIRMED visit confirmed within this many ms of being created counts as "just made by staff" (pinned for the day). */
export const PIN_CONFIRMED_WITHIN_MS = 5000;
/** Internal note a staff member may add when cancelling (never shown to the customer). */
export const CANCEL_NOTE_MAX = 300;
export const STAFF_CUSTOMER_SEARCH_MAX = 10;
export const STAFF_CUSTOMER_SEARCH_MIN_CHARS = 3;
/** `needsOutcome` filter looks back this many days when `from` is not given. */
export const NEEDS_OUTCOME_LOOKBACK_DAYS = 7;
/** `cancellationReason` prefix of rows hidden because the visit moved to a new slot. */
export const RESCHEDULED_PREFIX = 'RESCHEDULED:';

/** Reasons a staff member picks from when cancelling a visit. */
export const CancelReasonCode = Object.freeze({
  CUSTOMER_WILL_NOT_COME: 'CUSTOMER_WILL_NOT_COME',
  SHOWROOM_BUSY: 'SHOWROOM_BUSY',
  CUSTOMER_CHANGED_MIND: 'CUSTOMER_CHANGED_MIND',
  OTHER: 'OTHER',
});

/** Text shown to the customer (screen and email) for each staff cancel reason. */
export const CANCEL_REASON_LABELS = Object.freeze({
  [CancelReasonCode.CUSTOMER_WILL_NOT_COME]: 'Bạn đã báo không thể đến',
  [CancelReasonCode.SHOWROOM_BUSY]: 'Showroom có việc đột xuất',
  [CancelReasonCode.CUSTOMER_CHANGED_MIND]: 'Bạn đã thay đổi ý định',
  [CancelReasonCode.OTHER]: 'Showroom đã hủy lịch hẹn của bạn',
});

/** Statuses that occupy a car / a slot. */
export const OPEN_STATUSES = Object.freeze([
  AppointmentStatus.PENDING,
  AppointmentStatus.CONFIRMED,
]);

/** `cancellationReason` prefix written when a car stops being sellable (auto-cancel). */
export const AUTO_CANCEL_PREFIX = 'AUTO_CAR_UNAVAILABLE:';
/** `cancellationReason` of a booking that lost a concurrent race (soft-hidden). */
export const RACE_LOST_REASON = 'RACE_LOST';
/** `cancellationReason` of rows hidden because writing the rest of the visit failed. */
export const ABORTED_REASON = 'BOOKING_ABORTED';

export const CancellationType = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  STAFF: 'STAFF',
  CAR_UNAVAILABLE: 'CAR_UNAVAILABLE',
});

/** Why a slot cannot be booked (GET /slots). */
export const SlotReason = Object.freeze({
  PAST: 'PAST', // staff view only: the slot has already started
  TOO_SOON: 'TOO_SOON',
  TOO_FAR: 'TOO_FAR',
  CAR_BOOKED: 'CAR_BOOKED',
  CAPACITY_FULL: 'CAPACITY_FULL',
  ALREADY_BOOKED: 'ALREADY_BOOKED',
});
