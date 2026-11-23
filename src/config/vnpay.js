/**
 * @file vnpay.js
 * @description KAN-99 — VNPay sandbox integration configuration.
 *
 * All settings read lazily from `process.env` so dotenv (loaded in server.js) is
 * applied before the first use — mirrors the pattern in depositConstants.js.
 *
 * ── Env variables (all optional) ───────────────────────────────────────────────
 *   VNPAY_TMN_CODE            – Terminal code from the sandbox merchant portal
 *   VNPAY_HASH_SECRET         – Secret used for HMAC-SHA512 signing
 *   VNPAY_PAYMENT_URL         – VNPay payment page, default sandbox URL
 *   VNPAY_QUERY_URL           – transaction query endpoint (used by reconcile job, optional)
 *   VNPAY_RETURN_URL          – full absolute URL the browser is redirected to
 *   VNPAY_IPN_URL             – full absolute URL VNPay webhooks (not consumed here but kept for ops)
 *   VNPAY_IP_WHITELIST        – comma-separated IP list; empty = allow any (dev only)
 *   VNPAY_TIMEOUT_MINUTES     – how long the customer has on the VNPay page, default 15
 *   VNPAY_RECONCILE_INTERVAL_MS – reconcile job tick, default 5 minutes
 *   VNPAY_LOCALE              – vn | en, default 'vn'
 *
 * The module exposes:
 *   - getVnpayConfig(): parsed config + `enabled` flag
 *   - isVnpayEnabled(): fast truthy check without parsing all fields
 *   - assertVnpayEnabled(): throws AppError(VNPAY_NOT_CONFIGURED) when disabled
 *
 * NOTE: VNPAY_HASH_SECRET is treated like a password — never log, never return in
 * an API response, never commit. The .env.example documents the variable name only.
 */

import { AppError } from '../utils/apiResponse.js';
import { DepositErrorCode } from '../constants/depositConstants.js';

const DEFAULTS = Object.freeze({
  paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  queryUrl:   'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction',
  timeoutMinutes:      15,
  reconcileIntervalMs: 5 * 60 * 1000,
  locale: 'vn',
});

const trim = (value) => (typeof value === 'string' ? value.trim() : value);

const parseIntOrDefault = (value, fallback, { min = 0 } = {}) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min) return fallback;
  return num;
};

/**
 * Comma-separated IPs → trimmed array. Empty string → empty array.
 * @param {string|undefined} raw
 * @returns {string[]}
 */
const parseIpList = (raw) => {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

/**
 * Parse all VNPay-related env vars. `enabled` is true only when both the merchant
 * credentials are set — missing either disables the whole feature so the service
 * keeps running on a laptop without secrets.
 *
 * @returns {{
 *   tmnCode: string|null,
 *   hashSecret: string|null,
 *   paymentUrl: string,
 *   queryUrl: string,
 *   returnUrl: string|null,
 *   ipnUrl: string|null,
 *   ipWhitelist: string[],
 *   timeoutMinutes: number,
 *   reconcileIntervalMs: number,
 *   locale: 'vn'|'en',
 *   enabled: boolean,
 * }}
 */
export const getVnpayConfig = () => {
  const tmnCode = trim(process.env.VNPAY_TMN_CODE) || null;
  const hashSecret = trim(process.env.VNPAY_HASH_SECRET) || null;
  const paymentUrl = trim(process.env.VNPAY_PAYMENT_URL) || DEFAULTS.paymentUrl;
  const queryUrl = trim(process.env.VNPAY_QUERY_URL) || DEFAULTS.queryUrl;
  const returnUrl = trim(process.env.VNPAY_RETURN_URL) || null;
  const ipnUrl = trim(process.env.VNPAY_IPN_URL) || null;
  const ipWhitelist = parseIpList(process.env.VNPAY_IP_WHITELIST);
  const timeoutMinutes = parseIntOrDefault(process.env.VNPAY_TIMEOUT_MINUTES, DEFAULTS.timeoutMinutes, { min: 1 });
  const reconcileIntervalMs = parseIntOrDefault(
    process.env.VNPAY_RECONCILE_INTERVAL_MS,
    DEFAULTS.reconcileIntervalMs,
    { min: 30_000 },
  );
  const localeRaw = trim(process.env.VNPAY_LOCALE) || DEFAULTS.locale;
  const locale = localeRaw === 'en' ? 'en' : 'vn';

  return {
    tmnCode,
    hashSecret,
    paymentUrl,
    queryUrl,
    returnUrl,
    ipnUrl,
    ipWhitelist,
    timeoutMinutes,
    reconcileIntervalMs,
    locale,
    enabled: Boolean(tmnCode && hashSecret && returnUrl),
  };
};

/**
 * Fast feature flag — avoids building the full object.
 * @returns {boolean}
 */
export const isVnpayEnabled = () => Boolean(
  trim(process.env.VNPAY_TMN_CODE)
  && trim(process.env.VNPAY_HASH_SECRET)
  && trim(process.env.VNPAY_RETURN_URL),
);

/**
 * Throws a 503 AppError when VNPay is not configured. Used by controllers to
 * bail out early instead of building a malformed payment URL.
 * @param {ReturnType<typeof getVnpayConfig>} [config]
 * @returns {ReturnType<typeof getVnpayConfig>}
 */
export const assertVnpayEnabled = (config = getVnpayConfig()) => {
  if (!config.enabled) {
    throw new AppError(
      'Cổng thanh toán VNPay chưa được cấu hình. Vui lòng liên hệ quản trị viên.',
      503,
      DepositErrorCode.VNPAY_NOT_CONFIGURED,
    );
  }
  return config;
};

/**
 * Checks whether an incoming request IP is allowed to call the IPN endpoint.
 * Returns true when no whitelist is configured — dev-friendly.
 * @param {string|null|undefined} ip
 * @param {string[]} [whitelist]
 * @returns {boolean}
 */
export const isIpAllowed = (ip, whitelist = getVnpayConfig().ipWhitelist) => {
  if (!whitelist || whitelist.length === 0) return true;
  if (!ip) return false;
  // Normalise IPv4-mapped IPv6 (e.g. ::ffff:118.69.126.44) → 118.69.126.44.
  const normalised = ip.replace(/^::ffff:/i, '');
  return whitelist.includes(normalised);
};

export default {
  getVnpayConfig,
  isVnpayEnabled,
  assertVnpayEnabled,
  isIpAllowed,
};
