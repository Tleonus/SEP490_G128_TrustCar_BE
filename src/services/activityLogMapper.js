/**
 * @file activityLogMapper.js
 * @description Maps stored activity-log documents to the admin API shapes (KAN-40).
 * Allow-list only: nothing is returned that is not named here (no `_id`, `__v`, raw Mongoose document).
 * The detail view hides secret-like values as a last line of defence in case a service ever logged one.
 *
 * Ref: .sdd/features/system-audit-logs/SPEC.md (REQ-007, REQ-008, REQ-012; C8, C9)
 */

/** Keys whose value must never leave the server (C9). Deliberately broad: better to over-hide than leak. */
const SECRET_KEY = /pass(word)?|token|secret|hash|authorization|api[-_]?key/i;
export const HIDDEN = '[hidden]';
const TOO_DEEP = '[too deep]';
const MAX_DEPTH = 12;

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const idOf = (value) => (value === null || value === undefined ? null : String(value));

/**
 * Copy of `value` where the value of every secret-like key, at any depth, is replaced by `"[hidden]"`.
 * Only plain objects and arrays are walked (ObjectId, Date, Buffer… are returned as they are).
 * The original is never modified. Anything deeper than 12 levels is cut so a pathological document cannot
 * make the walk run away.
 *
 * @ears .sdd/features/system-audit-logs/SPEC.md#REQ-008
 * @param {*} value
 * @param {number} [depth]
 * @returns {*}
 */
export const hideSecrets = (value, depth = 0) => {
  if (Array.isArray(value)) {
    return depth >= MAX_DEPTH ? TOO_DEEP : value.map((item) => hideSecrets(item, depth + 1));
  }
  if (!isPlainObject(value)) return value;
  if (depth >= MAX_DEPTH) return TOO_DEEP;

  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = SECRET_KEY.test(key) ? HIDDEN : hideSecrets(item, depth + 1);
  }
  return copy;
};

/**
 * One row of the list: who, what, on which object, when, from where. No `changes`, `metadata` or user agent.
 *
 * @ears .sdd/features/system-audit-logs/SPEC.md#REQ-007
 * @param {object} doc Lean activity-log document
 */
export const toListItem = (doc) => ({
  id: String(doc._id),
  eventType: doc.eventType,
  createdAt: doc.createdAt,
  actor: { id: idOf(doc.performedBy), email: doc.performedByEmail ?? null },
  target: { model: doc.targetModel ?? null, id: idOf(doc.targetId), code: doc.targetCode ?? null },
  summary: doc.summary ?? null,
  ipAddress: doc.ipAddress ?? null,
});

/**
 * The list row plus `changes`, `metadata` and `userAgent`, with secret-like values hidden.
 *
 * @ears .sdd/features/system-audit-logs/SPEC.md#REQ-008
 * @param {object} doc Lean activity-log document
 */
export const toDetail = (doc) => ({
  ...toListItem(doc),
  changes: doc.changes
    ? { before: hideSecrets(doc.changes.before ?? null), after: hideSecrets(doc.changes.after ?? null) }
    : null,
  metadata: doc.metadata === null || doc.metadata === undefined ? null : hideSecrets(doc.metadata),
  userAgent: doc.userAgent ?? null,
});

export default { hideSecrets, toListItem, toDetail, HIDDEN };
