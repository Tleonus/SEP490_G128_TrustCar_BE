/**
 * @file appointmentRescheduleChain.js
 * @description How many times a visit has been rescheduled (Spec C17): in total (shown to everyone,
 * never capped) and by the customer themselves (the online limit, REQ-032).
 *
 * Stored counts: since this change every row written by a move carries `rescheduleCount` (all
 * moves) and `customerRescheduleCount` (moves made by the customer). A visit whose rows all carry
 * them is answered from the rows, with no query.
 *
 * Older visits (rows without the counts) are counted from the hidden rows a move leaves behind
 * (`cancellationReason = 'RESCHEDULED:<new visit code>'`): the predecessor of a visit is "the
 * hidden rows whose reason names one of this visit's codes", and so on back. Each hop is one query
 * for a whole page of visits. Who made each old move is read from the hidden rows' `updatedBy`
 * (one more query for the users); when it cannot be told, the move counts as the customer's, so
 * nobody gets more online moves than before. A broken chain (a car of an earlier visit was
 * cancelled between two moves) can under-count — never over-count.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (C17, REQ-032, NFR-09), PLAN.md 12.1
 */

import { RESCHEDULED_PREFIX } from '../constants/appointmentRules.js';
import User from '../models/User.js';
import { findHiddenReschedules } from './appointmentQueries.js';

/** Safety stop for walking an old chain; far above any real number of moves. */
export const MAX_CHAIN_HOPS = 50;

const CUSTOMER_ROLE = 'CUSTOMER';

const unique = (values) => [...new Set(values.map(String))];
const codesOf = (rows) => rows.map((row) => row.appointmentCode).filter(Boolean);
const isCount = (value) => Number.isInteger(value) && value >= 0;

/**
 * The counts stored on the rows of a visit, or null when any row predates them.
 * A car added to the visit later starts at 0, so the visit takes the highest value of its rows.
 *
 * @returns {{ total: number, byCustomer: number } | null}
 */
export const storedCounts = (visit) => {
  const rows = visit.rows ?? [];
  if (rows.length === 0 || !rows.every((row) => isCount(row.rescheduleCount))) return null;
  return {
    total: Math.max(...rows.map((row) => row.rescheduleCount)),
    byCustomer: Math.max(...rows.map((row) => (isCount(row.customerRescheduleCount) ? row.customerRescheduleCount : row.rescheduleCount))),
  };
};

/** Old visits: walk the hidden rows. Returns `visitId` → movers (one `updatedBy` per move, may be null). */
const walkChains = async (visits) => {
  const movers = new Map(visits.map((visit) => [visit.visitId, []]));
  let active = visits.map((visit) => ({ id: visit.visitId, customer: String(visit.customer), codes: codesOf(visit.rows) }));

  for (let hop = 0; hop < MAX_CHAIN_HOPS && active.length > 0; hop += 1) {
    const reasons = unique(active.flatMap((item) => item.codes.map((code) => `${RESCHEDULED_PREFIX}${code}`)));
    if (reasons.length === 0) break;
    const hidden = await findHiddenReschedules({ customerIds: unique(active.map((item) => item.customer)), reasons });

    active = active.flatMap((item) => {
      const earlier = hidden.filter((row) =>
        String(row.customer) === item.customer && item.codes.some((code) => row.cancellationReason === `${RESCHEDULED_PREFIX}${code}`));
      if (earlier.length === 0) return [];
      const mover = earlier.find((row) => row.updatedBy)?.updatedBy ?? null;
      movers.get(item.id).push(mover ? String(mover) : null);
      return [{ ...item, codes: codesOf(earlier) }];
    });
  }
  return movers;
};

/** Ids of the movers that are NOT customer accounts (= staff). Unknown users are not staff. */
const staffAmong = async (ids) => {
  if (ids.length === 0) return new Set();
  const users = await User.find({ _id: { $in: ids } }).select('roleName').lean();
  return new Set(users.filter((user) => user.roleName && user.roleName !== CUSTOMER_ROLE).map((user) => String(user._id)));
};

/**
 * @param {Array<{ visitId: string, customer: *, rows: object[] }>} visits Grouped visits of one page.
 * @returns {Promise<Map<string, { total: number, byCustomer: number }>>} Earlier reschedules per visit.
 */
export const rescheduleCountsOf = async (visits) => {
  const result = new Map();
  const legacy = [];
  visits.forEach((visit) => {
    const stored = storedCounts(visit);
    if (stored) result.set(visit.visitId, stored);
    else legacy.push(visit);
  });
  if (legacy.length === 0) return result;

  const movers = await walkChains(legacy);
  const staff = await staffAmong(unique([...movers.values()].flat().filter(Boolean)));
  legacy.forEach((visit) => {
    const list = movers.get(visit.visitId);
    result.set(visit.visitId, { total: list.length, byCustomer: list.filter((id) => !id || !staff.has(id)).length });
  });
  return result;
};

/** Total reschedules per visit (`visitId` → number), for screens that only show the number. */
export const countReschedules = async (visits) => {
  const counts = await rescheduleCountsOf(visits);
  return new Map([...counts].map(([id, value]) => [id, value.total]));
};

export default { rescheduleCountsOf, countReschedules, storedCounts };
