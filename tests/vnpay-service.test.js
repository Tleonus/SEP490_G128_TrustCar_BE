/**
 * @file vnpay-service.test.js
 * @description KAN-99 — pure-function tests for the VNPay HMAC helpers.
 *
 * These tests exercise only the functions in src/services/vnpayService.js —
 * no DB, no HTTP, no process.env mutation side-effects visible outside the
 * test (we always restore after).
 */

import {
  toAscii,
  canonicalise,
  signParams,
  verifySignature,
  parseVnpDate,
  generateTxnRef,
  buildPaymentUrl,
  summariseIpnForLog,
} from '../src/services/vnpayService.js';

const SECRET = 'TESTSECRET_4A6D5F8C2B9E1A7D';

const withEnv = (overrides, fn) => {
  const saved = {};
  Object.keys(overrides).forEach((k) => { saved[k] = process.env[k]; });
  Object.entries(overrides).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  });
  try {
    return fn();
  } finally {
    Object.entries(saved).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  }
};

describe('toAscii: strip Vietnamese diacritics + non-printable chars', () => {
  test('removes dấu tiếng Việt', () => {
    expect(toAscii('Đặt cọc xe Mazda CX-5')).toBe('Dat coc xe Mazda CX-5');
  });

  test('keeps digits, dash, slash, dot, comma', () => {
    expect(toAscii('TC-2026-0001 / 500,000,000 VND.')).toBe('TC-2026-0001 / 500,000,000 VND.');
  });

  test('null / empty / non-string → empty', () => {
    expect(toAscii(null)).toBe('');
    expect(toAscii(undefined)).toBe('');
    expect(toAscii('')).toBe('');
  });

  test('strips control chars that would break HMAC consistency', () => {
    expect(toAscii('Dat\u0007coc\tjasmine')).toBe('Datcocjasmine');
  });
});

describe('canonicalise: VNPay signed-string contract', () => {
  test('sorts keys alphabetically and ignores vnp_SecureHash*', () => {
    const str = canonicalise({
      vnp_Amount: '1000000',
      vnp_TmnCode: 'TMN01',
      vnp_Command: 'pay',
      vnp_SecureHash: 'SHOULD_NOT_APPEAR',
      vnp_SecureHashType: 'SHA512',
    });
    expect(str).toBe('vnp_Amount=1000000&vnp_Command=pay&vnp_TmnCode=TMN01');
    expect(str).not.toMatch(/SHOULD_NOT_APPEAR/);
    expect(str).not.toMatch(/vnp_SecureHashType/);
  });

  test('url-encodes values form-urlencoded style (space → "+", slash → %2F)', () => {
    // VNPay's official Node sample uses application/x-www-form-urlencoded, so
    // space is `+` not `%20`. Any drift here means outbound signatures will
    // fail verification on VNPay's side with "Sai chữ ký".
    const str = canonicalise({ vnp_OrderInfo: 'Dat coc', vnp_TxnRef: 'TC/01' });
    expect(str).toBe('vnp_OrderInfo=Dat+coc&vnp_TxnRef=TC%2F01');
  });

  test('is deterministic when called twice on the same input', () => {
    const payload = { vnp_B: '1', vnp_A: '2', vnp_C: '3' };
    expect(canonicalise(payload)).toBe(canonicalise({ ...payload }));
  });
});

describe('signParams: HMAC-SHA512 hex output', () => {
  test('produces a 128-character lowercase hex digest', () => {
    const hash = signParams({ vnp_Amount: '1000000' }, SECRET);
    expect(hash).toMatch(/^[0-9a-f]{128}$/);
  });

  test('is deterministic', () => {
    const a = signParams({ vnp_Amount: '100', vnp_TxnRef: 'A' }, SECRET);
    const b = signParams({ vnp_TxnRef: 'A', vnp_Amount: '100' }, SECRET);
    expect(a).toBe(b);
  });

  test('changes when the amount changes (not vulnerable to sort-only confusion)', () => {
    const a = signParams({ vnp_Amount: '100' }, SECRET);
    const b = signParams({ vnp_Amount: '200' }, SECRET);
    expect(a).not.toBe(b);
  });
});

describe('verifySignature: timing-safe acceptance + tamper rejection', () => {
  test('accepts a self-signed payload', () => {
    const payload = {
      vnp_TmnCode: 'TMN01',
      vnp_Amount: '1500000',
      vnp_TxnRef: 'DEP-TEST-001',
      vnp_Command: 'pay',
    };
    payload.vnp_SecureHash = signParams(payload, SECRET);
    expect(verifySignature(payload, SECRET)).toBe(true);
  });

  test('rejects a payload with the amount tampered', () => {
    const payload = {
      vnp_TmnCode: 'TMN01',
      vnp_Amount: '1500000',
      vnp_TxnRef: 'DEP-TEST-002',
      vnp_Command: 'pay',
    };
    payload.vnp_SecureHash = signParams(payload, SECRET);
    payload.vnp_Amount = '150000000'; // attacker adds two zeros
    expect(verifySignature(payload, SECRET)).toBe(false);
  });

  test('rejects when vnp_SecureHash is missing', () => {
    expect(verifySignature({ vnp_Amount: '1' }, SECRET)).toBe(false);
  });

  test('rejects when the hash has the wrong length (would throw timingSafeEqual)', () => {
    const payload = { vnp_Amount: '1', vnp_SecureHash: 'aaaa' };
    expect(verifySignature(payload, SECRET)).toBe(false);
  });

  test('rejects when the hash is uppercase but mismatches', () => {
    // Signature comparison is case-insensitive via `.toLowerCase()`; a wrong
    // signature in uppercase must still be rejected.
    const payload = { vnp_Amount: '1', vnp_SecureHash: 'DEADBEEF'.repeat(16) };
    expect(verifySignature(payload, SECRET)).toBe(false);
  });

  test('returns false when secret is empty', () => {
    const payload = { vnp_Amount: '1' };
    payload.vnp_SecureHash = signParams(payload, SECRET);
    expect(verifySignature(payload, '')).toBe(false);
  });

  test('ignores both hash fields when re-signing', () => {
    const payload = {
      vnp_Amount: '200',
      vnp_TxnRef: 'X',
      vnp_SecureHashType: 'SHA512',
    };
    payload.vnp_SecureHash = signParams(payload, SECRET);
    // With vnp_SecureHashType still present verification must still pass.
    expect(verifySignature(payload, SECRET)).toBe(true);
  });
});

describe('parseVnpDate: yyyyMMddHHmmss → Date (UTC)', () => {
  test('parses a well-formed timestamp', () => {
    const d = parseVnpDate('20261120103045');
    expect(d).toBeInstanceOf(Date);
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(10);
    expect(d.getUTCDate()).toBe(20);
    expect(d.getUTCHours()).toBe(10);
    expect(d.getUTCMinutes()).toBe(30);
    expect(d.getUTCSeconds()).toBe(45);
  });

  test('returns null for non-numeric input', () => {
    expect(parseVnpDate('abcdefg')).toBeNull();
  });

  test('returns null for wrong length', () => {
    expect(parseVnpDate('202611201030')).toBeNull();
  });

  test('returns null for null/undefined', () => {
    expect(parseVnpDate(null)).toBeNull();
    expect(parseVnpDate(undefined)).toBeNull();
  });
});

describe('generateTxnRef: deterministic by seed', () => {
  test('includes deposit code and the ms stamp', () => {
    expect(generateTxnRef('DC-261120-ABC123', 1700475600000)).toBe('DEP-DC-261120-ABC123-1700475600000');
  });

  test('strips unsafe chars from the code', () => {
    expect(generateTxnRef('DC/261120 ABC"123', 1)).toBe('DEP-DC261120ABC123-1');
  });

  test('falls back to NULL when the code is empty', () => {
    expect(generateTxnRef('', 10)).toBe('DEP-NULL-10');
    expect(generateTxnRef(null, 10)).toBe('DEP-NULL-10');
  });
});

describe('buildPaymentUrl: happy path', () => {
  const deposit = {
    depositCode: 'DC-261120-ABC123',
    depositAmount: 10_000_000,
    carVehicleCode: 'TC-2026-0001',
    carTitle: 'Toyota Camry 2.5Q 2019',
  };
  const envOk = {
    VNPAY_TMN_CODE: 'TMNTEST',
    VNPAY_HASH_SECRET: SECRET,
    VNPAY_RETURN_URL: 'https://staging.trustcar.vn/dat-coc/vnpay-return',
    VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    VNPAY_TIMEOUT_MINUTES: '15',
  };

  test('builds a URL with vnp_Amount = VND × 100 and a valid hash', () => {
    withEnv(envOk, () => {
      const now = new Date('2026-11-20T10:00:00Z');
      const { paymentUrl, vnpTxnRef, expiresAt, params } = buildPaymentUrl({
        deposit,
        ipAddress: '113.161.74.209',
        now,
      });

      expect(params.vnp_Amount).toBe('1000000000'); // 10,000,000 × 100
      expect(params.vnp_TmnCode).toBe('TMNTEST');
      expect(params.vnp_TxnRef).toBe(vnpTxnRef);
      expect(params.vnp_OrderInfo).toMatch(/Dat coc xe TC-2026-0001/);
      expect(params.vnp_ReturnUrl).toBe('https://staging.trustcar.vn/dat-coc/vnpay-return');
      expect(params.vnp_Version).toBe('2.1.0');
      expect(params.vnp_Command).toBe('pay');
      expect(params.vnp_IpAddr).toBe('113.161.74.209');
      expect(paymentUrl).toContain('https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?');
      expect(paymentUrl).toMatch(/vnp_SecureHash=[0-9a-f]{128}$/);
      expect(expiresAt.getTime()).toBe(now.getTime() + 15 * 60 * 1000);
    });
  });

  test('round-trip: the generated URL verifies with the same secret', () => {
    withEnv(envOk, () => {
      const { paymentUrl, params } = buildPaymentUrl({
        deposit,
        ipAddress: '1.1.1.1',
        now: new Date('2026-11-20T10:00:00Z'),
      });
      const url = new URL(paymentUrl);
      const query = {};
      url.searchParams.forEach((v, k) => { query[k] = v; });
      // Without the hash field, re-signing the rest must match.
      const expected = signParams(params, SECRET);
      expect(query.vnp_SecureHash).toBe(expected);
    });
  });

  test('throws when env secret missing', () => {
    withEnv({ ...envOk, VNPAY_HASH_SECRET: undefined }, () => {
      expect(() => buildPaymentUrl({
        deposit,
        ipAddress: '1.1.1.1',
        now: new Date(),
      })).toThrow(/VNPay/i);
    });
  });

  test('falls back IPv6-mapped IP to plain IPv4', () => {
    withEnv(envOk, () => {
      const { params } = buildPaymentUrl({
        deposit,
        ipAddress: '::ffff:113.161.74.209',
        now: new Date(),
      });
      expect(params.vnp_IpAddr).toBe('113.161.74.209');
    });
  });

  test('replaces missing IP with 127.0.0.1 so sandbox accepts', () => {
    withEnv(envOk, () => {
      const { params } = buildPaymentUrl({ deposit, ipAddress: '', now: new Date() });
      expect(params.vnp_IpAddr).toBe('127.0.0.1');
    });
  });
});

describe('summariseIpnForLog: masking', () => {
  test('masks the hash to prefix…suffix (length)', () => {
    const q = {
      vnp_TxnRef: 'DEP-X-1',
      vnp_TransactionNo: '14600314',
      vnp_Amount: '1000000000',
      vnp_SecureHash: 'a'.repeat(128),
    };
    const summary = summariseIpnForLog(q);
    expect(summary.vnp_TxnRef).toBe('DEP-X-1');
    expect(summary.vnp_SecureHash).toMatch(/^[a0-9a-f]{6}…[a0-9a-f]{4} \(128 chars\)$/);
  });

  test('short / missing hash collapses to ***', () => {
    expect(summariseIpnForLog({}).vnp_SecureHash).toBe('***');
    expect(summariseIpnForLog({ vnp_SecureHash: 'abc' }).vnp_SecureHash).toBe('***');
  });
});
