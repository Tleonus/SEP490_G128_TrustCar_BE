/**
 * @file vehicle-history-hash.test.js
 * @description KAN-98 — deterministic verify hash.
 */

import { buildHistoryVerifyHash, HISTORY_HASH_LENGTH } from '../src/services/vehicleHistoryService.js';

const CAR = '65f000000000000000000001';
const CERT = 'CPO-20261201-A1B2';

describe('buildHistoryVerifyHash', () => {
  const original = process.env.VERIFY_HASH_SECRET;
  beforeEach(() => { process.env.VERIFY_HASH_SECRET = 'test-secret'; });
  afterEach(() => { process.env.VERIFY_HASH_SECRET = original; });

  test('T8 — same inputs produce the same 24-hex hash', () => {
    const a = buildHistoryVerifyHash(CAR, CERT);
    const b = buildHistoryVerifyHash(CAR, CERT);
    expect(a).toBe(b);
    expect(a).toHaveLength(HISTORY_HASH_LENGTH);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
  });

  test('T9 — a different certificate id changes the hash', () => {
    expect(buildHistoryVerifyHash(CAR, CERT)).not.toBe(buildHistoryVerifyHash(CAR, 'CPO-OTHER'));
  });

  test('T10 — a different secret changes the hash', () => {
    const first = buildHistoryVerifyHash(CAR, CERT);
    process.env.VERIFY_HASH_SECRET = 'rotated-secret';
    expect(buildHistoryVerifyHash(CAR, CERT)).not.toBe(first);
  });
});
