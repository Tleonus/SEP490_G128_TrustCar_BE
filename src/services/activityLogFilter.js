/**
 * @file activityLogFilter.js
 * @description Pure helpers that turn the validated admin query of the activity-log list
 * into a MongoDB filter (KAN-40). No database access here, so every rule is unit-testable.
 *
 * Ref: .sdd/features/system-audit-logs/SPEC.md (REQ-004, REQ-006; C4, C5, C7)
 */

import mongoose from 'mongoose';
import { parseDateKey, vnInstant } from './appointmentSlotRules.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Escapes every regular-expression metacharacter so user input is matched literally. */
export const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `createdAt` range for two `YYYY-MM-DD` Vietnam days: from 00:00 VN of `from` up to (not including)
 * 00:00 VN of the day after `to`, so `to` is inclusive. Vietnam has no daylight saving, so a day is 24 h.
 * Missing or non-existent dates are ignored (the route validates them before this runs).
 *
 * @ears .sdd/features/system-audit-logs/SPEC.md#REQ-006
 * @param {string} [from]
 * @param {string} [to]
 * @returns {{ $gte?: Date, $lt?: Date }}
 */
export const dayRange = (from, to) => {
  const start = from ? parseDateKey(from) : null;
  const end = to ? parseDateKey(to) : null;
  const range = {};
  if (start) range.$gte = vnInstant(start);
  if (end) range.$lt = new Date(vnInstant(end).getTime() + DAY_MS);
  return range;
};

/**
 * Newest first by default; `sort=asc` reverses. Ties are broken by `_id` in the same direction (C7).
 * @ears .sdd/features/system-audit-logs/SPEC.md#REQ-003
 * @returns {1|-1}
 */
export const sortDirection = (query = {}) => (query.sort === 'asc' ? 1 : -1);

/**
 * MongoDB filter for the list. All given filters are combined with AND.
 * `actorEmail` is a whole-string, case-insensitive match against the e-mail snapshot stored with
 * the log entry (some entries store the address exactly as typed, e.g. LOGIN_FAILED).
 *
 * @ears .sdd/features/system-audit-logs/SPEC.md#REQ-004
 * @param {object} [query] Validated query (`eventType`, `targetModel`, `targetId`, `targetCode`, `actorEmail`, `from`, `to`)
 * @returns {object}
 */
export const buildFilter = (query = {}) => {
  const filter = {};
  if (query.eventType) filter.eventType = query.eventType;
  if (query.targetModel) filter.targetModel = query.targetModel;
  if (query.targetId) filter.targetId = new mongoose.Types.ObjectId(String(query.targetId));
  if (query.targetCode) filter.targetCode = query.targetCode;
  if (query.actorEmail) filter.performedByEmail = new RegExp(`^${escapeRegex(String(query.actorEmail).trim())}$`, 'i');

  const range = dayRange(query.from, query.to);
  if (Object.keys(range).length > 0) filter.createdAt = range;
  return filter;
};

export default { escapeRegex, dayRange, sortDirection, buildFilter };
