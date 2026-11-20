/**
 * @file fakeVnpayIpnModels.js
 * @description KAN-99 — in-memory stand-ins for Deposit, VnpayIpnLog and
 * ActivityLog so the IPN pipeline can be driven without a real MongoDB.
 *
 * Only the methods actually called by src/services/vnpayIpnService.js are
 * mocked. The real Mongoose models remain the ones imported by the service —
 * jest.spyOn replaces the method implementations in place.
 */

import { jest } from '@jest/globals';
import Deposit from '../../src/models/Deposit.js';
import VnpayIpnLog from '../../src/models/VnpayIpnLog.js';
import ActivityLog from '../../src/models/ActivityLog.js';

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

/**
 * Attach fake implementations and return control handles.
 *
 * @returns {{
 *   deposits: object[],
 *   ipnLogs: object[],
 *   activityLogs: object[],
 *   addDeposit: (doc: object) => object,
 *   reset: () => void,
 * }}
 */
export const setupVnpayFakes = () => {
  const deposits = [];
  const ipnLogs = [];
  const activityLogs = [];

  const matchesDeposit = (d, filter = {}) => {
    for (const [key, cond] of Object.entries(filter)) {
      const val = d[key];
      if (cond && typeof cond === 'object' && cond.$in) {
        if (!cond.$in.some((c) => String(c) === String(val))) return false;
      } else if (String(val) !== String(cond)) {
        return false;
      }
    }
    return true;
  };

  // ── Deposit ────────────────────────────────────────────────────────────
  jest.spyOn(Deposit, 'findOne').mockImplementation((filter) => ({
    lean: async () => {
      const row = deposits.find((d) => matchesDeposit(d, filter));
      return row ? clone(row) : null;
    },
  }));

  jest.spyOn(Deposit, 'findOneAndUpdate').mockImplementation((filter, update) => ({
    lean: async () => {
      const idx = deposits.findIndex((d) => matchesDeposit(d, filter));
      if (idx < 0) return null;
      const row = deposits[idx];
      const next = { ...row, ...(update.$set || {}) };
      if (update.$push?.history) next.history = [...(row.history || []), update.$push.history];
      deposits[idx] = next;
      return clone(next);
    },
  }));

  jest.spyOn(Deposit, 'updateOne').mockImplementation(async (filter, update) => {
    const idx = deposits.findIndex((d) => matchesDeposit(d, filter));
    if (idx < 0) return { matchedCount: 0, modifiedCount: 0 };
    const row = deposits[idx];
    deposits[idx] = { ...row, ...(update.$set || {}) };
    if (update.$push?.history) {
      deposits[idx].history = [...(row.history || []), update.$push.history];
    }
    return { matchedCount: 1, modifiedCount: 1 };
  });

  // ── VnpayIpnLog ────────────────────────────────────────────────────────
  jest.spyOn(VnpayIpnLog, 'create').mockImplementation(async (doc) => {
    // Enforce the unique partial index — matches VnpayIpnLog model's
    // `outcome:'APPLIED'` partial filter. See model docstring.
    if (doc.outcome === 'APPLIED' && doc.vnpTxnRef && doc.vnpTransactionNo) {
      const exists = ipnLogs.some((l) => l.outcome === 'APPLIED'
        && l.vnpTxnRef === doc.vnpTxnRef
        && l.vnpTransactionNo === doc.vnpTransactionNo);
      if (exists) {
        const error = new Error('E11000 duplicate key');
        error.code = 11000;
        throw error;
      }
    }
    const row = { _id: `log-${ipnLogs.length + 1}`, receivedAt: new Date(), ...doc };
    ipnLogs.push(row);
    return row;
  });

  jest.spyOn(VnpayIpnLog, 'findOne').mockImplementation((filter) => ({
    lean: async () => {
      const row = ipnLogs.find((l) => {
        return Object.entries(filter).every(([k, v]) => {
          const lv = l[k];
          // Boolean compare so {verifiedSignature: true} matches booleans.
          if (typeof v === 'boolean') return Boolean(lv) === v;
          return String(lv) === String(v);
        });
      });
      return row ? clone(row) : null;
    },
  }));

  // ── ActivityLog ────────────────────────────────────────────────────────
  jest.spyOn(ActivityLog, 'create').mockImplementation(async (doc) => {
    activityLogs.push({ _id: `act-${activityLogs.length + 1}`, ...doc });
    return doc;
  });

  const reset = () => {
    deposits.length = 0;
    ipnLogs.length = 0;
    activityLogs.length = 0;
    jest.clearAllMocks();
  };

  return {
    deposits,
    ipnLogs,
    activityLogs,
    addDeposit: (doc) => {
      const row = { _id: `dep-${deposits.length + 1}`, history: [], ...doc };
      deposits.push(row);
      return row;
    },
    reset,
  };
};

export default { setupVnpayFakes };
