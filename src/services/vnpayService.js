/**
 * @file vnpayService.js
 * @description KAN-99 — VNPay HMAC core: build payment URL + verify incoming signatures.
 *
 * SCOPE: pure functions only (no DB, no Express). State transitions live in
 * vnpayIpnService.js so this file stays fully unit-testable.
 *
 * ── Signing algorithm (VNPay v2.1.0) ───────────────────────────────────────────
 *   1. Collect all vnp_* parameters.
 *   2. Remove the hash fields from the payload (`vnp_SecureHash`, `vnp_SecureHashType`).
 *   3. Sort keys alphabetically.
 *   4. Build the canonical string as `k=encode(v)&k=encode(v)…` using RFC-3986
 *      percent-encoding — Node's `URLSearchParams` already matches this.
 *   5. HMAC-SHA512 with `VNPAY_HASH_SECRET` as the key, output as lowercase hex.
 *
 * ── Gotchas learned from the VNPay docs + community reports ───────────────────
 *   - `vnp_Amount` must be VND × 100 (integer). The sandbox rejects non-integers.
 *   - `vnp_OrderInfo` MUST be ASCII. Vietnamese accents sneak in from `car.title` —
 *      we strip them with the included `toAscii` helper so the HMAC stays stable.
 *   - `vnp_IpAddr` must be the CUSTOMER IP, not the server IP; the controller
 *      resolves this from `req.ip` (behind `app.set('trust proxy', true)`).
 *   - Both `vnp_SecureHash` AND `vnp_SecureHashType` have to be excluded before
 *      signing — missing the second one silently breaks the signature.
 *   - `timingSafeEqual` is used for verification to avoid leaking information
 *      through response-time differences on hash mismatch.
 */

import crypto from 'node:crypto';
import dayjs from 'dayjs';
import { getVnpayConfig, assertVnpayEnabled } from '../config/vnpay.js';

/** Keys we exclude from the signed payload. */
const HASH_FIELDS = Object.freeze(['vnp_SecureHash', 'vnp_SecureHashType']);

/**
 * Strip Vietnamese diacritics + anything outside 0x20..0x7E. Keeps letters,
 * digits, spaces, and basic punctuation. Used only for `vnp_OrderInfo` — all
 * other fields are already ASCII by construction.
 *
 * @param {string} input
 * @returns {string}
 */
export const toAscii = (input) => {
  if (!input) return '';
  return String(input)
    .normalize('NFD')
    // Strip Unicode combining diacritics (U+0300..U+036F)
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    // Keep only printable ASCII after accent removal
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
};

/**
 * Build the canonical string VNPay expects as the HMAC input.
 * Sorts the keys alphabetically and encodes values using `URLSearchParams`,
 * which follows the same `application/x-www-form-urlencoded` rules VNPay uses.
 *
 * @param {Record<string, string|number>} params
 * @returns {string}
 */
export const canonicalise = (params) => {
  const keys = Object.keys(params).filter((k) => !HASH_FIELDS.includes(k)).sort();
  return keys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
};

/**
 * HMAC-SHA512 of the canonical string with the configured secret, hex-encoded.
 *
 * @param {Record<string, string|number>} params
 * @param {string} secret
 * @returns {string} lowercase hex digest
 */
export const signParams = (params, secret) => {
  const data = canonicalise(params);
  return crypto.createHmac('sha512', secret).update(data, 'utf8').digest('hex');
};

/**
 * Verify a signed payload coming from VNPay (IPN or return URL). Uses
 * `timingSafeEqual` so a mismatch at byte 1 and byte 64 take the same time.
 *
 * Returns false (never throws) for any shape error so callers can log and move on.
 *
 * @param {Record<string, string>} query
 * @param {string} [secret]
 * @returns {boolean}
 */
export const verifySignature = (query, secret = getVnpayConfig().hashSecret) => {
  if (!query || typeof query !== 'object' || !secret) return false;
  const supplied = query.vnp_SecureHash;
  if (typeof supplied !== 'string' || supplied.length === 0) return false;

  let expected;
  try {
    expected = signParams(query, secret);
  } catch {
    return false;
  }

  const a = Buffer.from(supplied.toLowerCase(), 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

/**
 * Parse the `yyyyMMddHHmmss` string VNPay returns in `vnp_PayDate`. Returns
 * null on any malformed input — downstream code should treat null as "no
 * verified pay time".
 *
 * @param {string|null|undefined} value
 * @returns {Date|null}
 */
export const parseVnpDate = (value) => {
  if (typeof value !== 'string' || !/^\d{14}$/.test(value)) return null;
  const y = Number(value.slice(0, 4));
  const mo = Number(value.slice(4, 6)) - 1;
  const d = Number(value.slice(6, 8));
  const h = Number(value.slice(8, 10));
  const mi = Number(value.slice(10, 12));
  const s = Number(value.slice(12, 14));
  const dt = new Date(Date.UTC(y, mo, d, h, mi, s));
  return Number.isNaN(dt.getTime()) ? null : dt;
};

/**
 * Generate the TxnRef sent to VNPay for one deposit. Shape: `DEP-{code}-{ms}`.
 * Deterministic in test by injecting `now`.
 *
 * @param {string} depositCode
 * @param {number} [nowMs]
 * @returns {string}
 */
export const generateTxnRef = (depositCode, nowMs = Date.now()) => {
  const safeCode = String(depositCode || 'NULL').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'NULL';
  return `DEP-${safeCode}-${nowMs}`;
};

/**
 * Build the full redirect URL the customer should be sent to.
 *
 * @param {object} args
 * @param {object} args.deposit                Deposit document (lean or Mongoose)
 * @param {string} args.ipAddress              Customer IP (from req.ip)
 * @param {Date}   [args.now]
 * @param {ReturnType<typeof getVnpayConfig>} [args.config]
 * @returns {{ paymentUrl: string, vnpTxnRef: string, expiresAt: Date, params: object }}
 */
export const buildPaymentUrl = ({ deposit, ipAddress, now = new Date(), config }) => {
  const cfg = assertVnpayEnabled(config || getVnpayConfig());

  const amount = Math.round(Number(deposit.depositAmount) * 100);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Deposit amount must be a positive integer (VND).');
  }

  const vnpTxnRef = generateTxnRef(deposit.depositCode, now.getTime());
  const createDate = dayjs(now).format('YYYYMMDDHHmmss');
  const expiresAt = new Date(now.getTime() + cfg.timeoutMinutes * 60_000);
  const expireDate = dayjs(expiresAt).format('YYYYMMDDHHmmss');

  const orderInfo = toAscii(
    `Dat coc xe ${deposit.carVehicleCode || deposit.carTitle || deposit.depositCode}`,
  ).slice(0, 255) || `Dat coc ${deposit.depositCode}`;

  // Fallback IP — if the client IP is missing or IPv6 shorthand `::1`, use a
  // documented placeholder so the sandbox does not reject the request.
  const ipAddr = (ipAddress || '').replace(/^::ffff:/i, '').trim() || '127.0.0.1';

  const params = {
    vnp_Version:    '2.1.0',
    vnp_Command:    'pay',
    vnp_TmnCode:    cfg.tmnCode,
    vnp_Amount:     String(amount),
    vnp_CurrCode:   'VND',
    vnp_TxnRef:     vnpTxnRef,
    vnp_OrderInfo:  orderInfo,
    vnp_OrderType:  'other',
    vnp_Locale:     cfg.locale,
    vnp_ReturnUrl:  cfg.returnUrl,
    vnp_IpAddr:     ipAddr,
    vnp_CreateDate: createDate,
    vnp_ExpireDate: expireDate,
  };

  const secureHash = signParams(params, cfg.hashSecret);
  const query = canonicalise(params);
  const paymentUrl = `${cfg.paymentUrl}?${query}&vnp_SecureHash=${secureHash}`;

  return { paymentUrl, vnpTxnRef, expiresAt, params };
};

/**
 * Convenience: build a minimal public-safe log summary for an IPN payload so
 * no secrets or full hashes leak into application logs.
 *
 * @param {Record<string, string>} query
 * @returns {object}
 */
export const summariseIpnForLog = (query) => {
  const hash = typeof query?.vnp_SecureHash === 'string' ? query.vnp_SecureHash : '';
  const maskedHash = hash.length <= 12 ? '***' : `${hash.slice(0, 6)}…${hash.slice(-4)} (${hash.length} chars)`;
  return {
    vnp_TxnRef:         query?.vnp_TxnRef ?? null,
    vnp_TransactionNo:  query?.vnp_TransactionNo ?? null,
    vnp_ResponseCode:   query?.vnp_ResponseCode ?? null,
    vnp_TransactionStatus: query?.vnp_TransactionStatus ?? null,
    vnp_Amount:         query?.vnp_Amount ?? null,
    vnp_BankCode:       query?.vnp_BankCode ?? null,
    vnp_PayDate:        query?.vnp_PayDate ?? null,
    vnp_SecureHash:     maskedHash,
  };
};

export default {
  toAscii,
  canonicalise,
  signParams,
  verifySignature,
  parseVnpDate,
  generateTxnRef,
  buildPaymentUrl,
  summariseIpnForLog,
};
