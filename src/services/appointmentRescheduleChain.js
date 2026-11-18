/**
 * @file appointmentRescheduleChain.js
 * @description How many times a visit has already been rescheduled (Spec C17), WITHOUT a
 * counter column (no schema change).
 *
 * Rescheduling hides the old rows with `cancellationReason = 'RESCHEDULED:<new visit code>'`.
 * So the predecessor of a visit is "the hidden rows whose reason names one of this visit's
 * codes", and the predecessor of THAT visit is found the same way from those rows' codes.
 * Each hop is one query for a whole page of visits (never one per visit).
 *
 * The count is capped at `MAX_RESCHEDULES_PER_VISIT + 1` (enough to know a customer is over
 * the limit). It can under-count if a car of an earlier visit was cancelled between two
 * reschedules (the chain then breaks) — never over-count, so nobody is blocked unfairly.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (C17, REQ-032, NFR-09), PLAN.md 12.1
 */

import { MAX_RESCHEDULES_PER_VISIT, RESCHEDULED_PREFIX } from '../constants/appointmentRules.js';
import { findHiddenReschedules } from './appointmentQueries.js';

const unique = (values) => [...new Set(values.map(String))];
const codesOf = (rows) => rows.map((row) => row.appointmentCode).filter(Boolean);

/**
 * @param {Array<{ visitId: string, customer: *, rows: object[] }>} visits Grouped visits of one page.
 * @returns {Promise<Map<string, number>>} `visitId` → earlier reschedules (0…MAX+1).
 */
export const countReschedules = async (visits) => {
  const counts = new Map(visits.map((visit) => [visit.visitId, 0]));
  let active = visits.map((visit) => ({ id: visit.visitId, customer: String(visit.customer), codes: codesOf(visit.rows) }));

  for (let hop = 0; hop <= MAX_RESCHEDULES_PER_VISIT && active.length > 0; hop += 1) {
    const reasons = unique(active.flatMap((item) => item.codes.map((code) => `${RESCHEDULED_PREFIX}${code}`)));
    if (reasons.length === 0) break;
    const hidden = await findHiddenReschedules({ customerIds: unique(active.map((item) => item.customer)), reasons });

    active = active.flatMap((item) => {
      const earlier = hidden.filter((row) =>
        String(row.customer) === item.customer && item.codes.some((code) => row.cancellationReason === `${RESCHEDULED_PREFIX}${code}`));
      if (earlier.length === 0) return [];
      counts.set(item.id, counts.get(item.id) + 1);
      return [{ ...item, codes: codesOf(earlier) }];
    });
  }
  return counts;
};

export default { countReschedules };
