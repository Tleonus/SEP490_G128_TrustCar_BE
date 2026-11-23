/**
 * @file activityLogService.js
 * @description READ-ONLY access to the immutable activity log for administrators (KAN-40).
 * Nothing here writes, updates or deletes, and reading does not itself create a log entry (REQ-011).
 *
 * Ref: .sdd/features/system-audit-logs/SPEC.md (REQ-003, 004, 008, 009, 010, 011)
 */

import ActivityLog from '../models/ActivityLog.js';
import { ActivityEventType } from '../constants/appConstants.js';
import { AuditAction, eventActionMap } from '../constants/auditActions.js';
import { AppError, buildPaginationMeta, parsePagination } from '../utils/apiResponse.js';
import { buildFilter, sortDirection } from './activityLogFilter.js';
import { toDetail, toListItem } from './activityLogMapper.js';

/**
 * One page of log entries, newest first (or oldest first with `sort=asc`), already validated by the route.
 *
 * @ears .sdd/features/system-audit-logs/SPEC.md#REQ-003
 * @ears .sdd/features/system-audit-logs/SPEC.md#REQ-004
 * @param {object} [query]
 * @returns {Promise<{ items: object[], pagination: object }>}
 */
export const listActivityLogs = async (query = {}) => {
  const { page, limit, skip } = parsePagination(query);
  const filter = buildFilter(query);
  const direction = sortDirection(query);

  const [docs, total] = await Promise.all([
    ActivityLog.find(filter).sort({ createdAt: direction, _id: direction }).skip(skip).limit(limit).lean(),
    ActivityLog.countDocuments(filter),
  ]);

  return { items: docs.map(toListItem), pagination: buildPaginationMeta(total, page, limit) };
};

/**
 * One entry with `changes`, `metadata` and user agent (secret-like values hidden).
 *
 * @ears .sdd/features/system-audit-logs/SPEC.md#REQ-008
 * @ears .sdd/features/system-audit-logs/SPEC.md#REQ-009
 * @param {string} id Already validated as an ObjectId by the route
 * @throws {AppError} 404 ACTIVITY_LOG_NOT_FOUND
 */
export const getActivityLog = async (id) => {
  const doc = await ActivityLog.findById(id).lean();
  if (!doc) throw new AppError('Activity log entry not found.', 404, 'ACTIVITY_LOG_NOT_FOUND');
  return toDetail(doc);
};

/**
 * Values the admin screen needs to build its filters: every known event type and every object type
 * that appears in the log (blank and null values dropped).
 *
 * @ears .sdd/features/system-audit-logs/SPEC.md#REQ-010
 * KAN-92 adds `actions`, `eventActions` (event type → action) and `actorEmails`.
 * @returns {Promise<{ eventTypes: string[], targetModels: string[], actions: string[], eventActions: object, actorEmails: string[] }>}
 */
export const getActivityLogMeta = async () => {
  const [models, emails] = await Promise.all([
    ActivityLog.distinct('targetModel'),
    ActivityLog.distinct('performedByEmail'),
  ]);
  const targetModels = [...new Set(models.filter((name) => typeof name === 'string' && name.trim() !== ''))].sort();

  // KAN-92: people who appear in the log (for the "Người thực hiện" select). Case-insensitive de-duplication,
  // first spelling kept; matched back with the case-insensitive `actorEmail` filter.
  const seen = new Map();
  for (const email of emails) {
    if (typeof email !== 'string' || email.trim() === '') continue;
    const key = email.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, email.trim());
  }
  const actorEmails = [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  return {
    eventTypes: Object.values(ActivityEventType).sort(),
    targetModels,
    actions: Object.values(AuditAction),
    eventActions: eventActionMap(),
    actorEmails,
  };
};

export default { listActivityLogs, getActivityLog, getActivityLogMeta };
