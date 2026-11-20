/**
 * @file vnpayController.js
 * @description KAN-99 — HTTP handlers for the three VNPay endpoints.
 *
 *   POST  /deposits/:id/vnpay-url   — build + return a signed payment URL (JWT owner / staff)
 *   GET   /deposits/vnpay-ipn       — webhook from VNPay (PUBLIC + IP whitelist)
 *   GET   /deposits/vnpay-return    — browser redirect back from VNPay (PUBLIC)
 *
 * The IPN handler ALWAYS responds HTTP 200 with a JSON body — any other shape
 * makes VNPay retry the webhook, which would flood our logs. The return URL
 * handler redirects to a human-readable FE page; it never updates the DB.
 */

import Deposit from '../models/Deposit.js';
import { createVnpayPaymentIntent } from '../services/depositService.js';
import { handleVnpayIpn } from '../services/vnpayIpnService.js';
import { verifySignature } from '../services/vnpayService.js';
import { getVnpayConfig, isIpAllowed, assertVnpayEnabled } from '../config/vnpay.js';
import { sendSuccess, AppError } from '../utils/apiResponse.js';
import {
  DepositErrorCode,
  DepositStatus,
  DepositPaymentStatus,
  PaymentProvider,
} from '../constants/depositConstants.js';
import logger from '../utils/logger.js';

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

/**
 * Resolve the FE base used for return redirects. Falls back to the VNPay
 * `returnUrl` origin so dev setups without `FRONTEND_BASE_URL` still work.
 * @returns {string} e.g. https://staging.trustcar.vn
 */
const resolveFeBase = () => {
  const explicit = (process.env.FRONTEND_BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const cfg = getVnpayConfig();
  if (cfg.returnUrl) {
    try {
      return new URL(cfg.returnUrl).origin;
    } catch {
      /* ignore malformed URL — fallback below */
    }
  }
  return '';
};

/** @route POST /api/v1/deposits/:id/vnpay-url (JWT: owner or staff) */
export const createVnpayUrl = handle(async (req, res) => {
  const data = await createVnpayPaymentIntent({
    user: req.user,
    depositId: req.params.id,
    ipAddress: req.ip,
  });
  return sendSuccess(res, 200, 'Đã tạo liên kết thanh toán VNPay.', data);
});

/**
 * @route GET /api/v1/deposits/vnpay-ipn (public — VNPay server-to-server)
 *
 * Always responds 200 JSON `{RspCode, Message}`. VNPay interprets any other
 * shape as "network error" and keeps retrying the IPN.
 */
export const vnpayIpn = handle(async (req, res) => {
  const ip = req.ip || null;
  const cfg = getVnpayConfig();

  if (!cfg.enabled) {
    // Unlikely in production; defend against misconfigured staging anyway.
    logger.warn('[vnpay-ipn] rejected: VNPay disabled on this instance');
    res.status(200).json({ RspCode: '99', Message: 'VNPay disabled' });
    return;
  }

  if (!isIpAllowed(ip, cfg.ipWhitelist)) {
    logger.warn('[vnpay-ipn] rejected: IP not in whitelist', { ip });
    res.status(200).json({ RspCode: '99', Message: 'IP not allowed' });
    return;
  }

  const result = await handleVnpayIpn({ query: req.query || {}, ipAddress: ip });
  res.status(200).json({ RspCode: result.RspCode, Message: result.Message });
});

/**
 * @route GET /api/v1/deposits/vnpay-return (public — browser redirect)
 *
 * Does NOT update the DB. Verifies the signature, then redirects to one of the
 * FE pages so the user sees a branded confirmation instead of a raw JSON body.
 */
export const vnpayReturn = handle(async (req, res) => {
  const cfg = getVnpayConfig();
  const feBase = resolveFeBase();
  const buildRedirect = (path, extra = {}) => {
    const url = new URL(`${feBase}${path}`, feBase || 'http://localhost');
    Object.entries(extra).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, String(v)); });
    return feBase ? url.toString() : `${path}${url.search}`;
  };

  if (!cfg.enabled) {
    return res.redirect(buildRedirect('/dat-coc/that-bai', { error: 'VNPAY_NOT_CONFIGURED' }));
  }

  const query = req.query || {};
  const signatureOk = verifySignature(query, cfg.hashSecret);
  if (!signatureOk) {
    logger.warn('[vnpay-return] invalid signature', { ip: req.ip, txnRef: query.vnp_TxnRef });
    return res.redirect(buildRedirect('/dat-coc/that-bai', { error: 'INVALID_SIGNATURE' }));
  }

  const vnpTxnRef = typeof query.vnp_TxnRef === 'string' ? query.vnp_TxnRef : null;
  const deposit = vnpTxnRef
    ? await Deposit.findOne({ vnpayTxnRef: vnpTxnRef }).lean()
    : null;

  const depositId = deposit?._id ? String(deposit._id) : null;
  const responseCode = String(query.vnp_ResponseCode || '');
  const txnNo = query.vnp_TransactionNo || null;

  if (!deposit) {
    return res.redirect(buildRedirect('/dat-coc/that-bai', { error: 'DEPOSIT_NOT_FOUND', txnRef: vnpTxnRef }));
  }

  if (responseCode === '24') {
    return res.redirect(buildRedirect(`/dat-coc/${depositId}/da-huy`, { code: responseCode }));
  }
  if (responseCode === '00') {
    return res.redirect(buildRedirect(`/dat-coc/${depositId}/thanh-cong`, { txn: txnNo }));
  }
  return res.redirect(buildRedirect(`/dat-coc/${depositId}/that-bai`, { code: responseCode }));
});

/** @route GET /api/v1/deposits/vnpay-policy (public) — show params the FE needs before redirect */
export const getVnpayPolicy = handle(async (req, res) => {
  const cfg = assertVnpayEnabled();
  return sendSuccess(res, 200, 'VNPay policy.', {
    enabled: cfg.enabled,
    timeoutMinutes: cfg.timeoutMinutes,
    locale: cfg.locale,
    returnUrl: cfg.returnUrl,
  });
});

/**
 * Preflight guard shared by createVnpayUrl so the service layer does not have
 * to re-validate every call. Exported for unit tests.
 */
export const assertDepositPayable = (deposit, user) => {
  if (!deposit) throw new AppError('Không tìm thấy lượt đặt cọc.', 404, DepositErrorCode.NOT_FOUND);
  const sameUser = String(deposit.userId) === String(user?._id);
  const isStaff = user?.roleName === 'ADMIN' || user?.roleName === 'SALES_STAFF';
  if (!sameUser && !isStaff) {
    throw new AppError('Bạn không có quyền truy cập lượt đặt cọc này.', 403, DepositErrorCode.USER_MISMATCH);
  }
  if (deposit.status !== DepositStatus.PENDING_PAYMENT) {
    throw new AppError('Lượt đặt cọc không còn ở trạng thái chờ thanh toán.', 409, DepositErrorCode.INVALID_STATE);
  }
  if (deposit.paymentStatus !== DepositPaymentStatus.UNPAID) {
    throw new AppError('Tiền cọc đã được ghi nhận trước đó.', 409, DepositErrorCode.VNPAY_ALREADY_PAID);
  }
  if (deposit.paymentProvider && deposit.paymentProvider !== PaymentProvider.VNPAY) {
    throw new AppError(
      'Phương thức thanh toán của lượt cọc này không phải VNPay. Vui lòng tạo lượt cọc mới chọn VNPay.',
      409,
      DepositErrorCode.VNPAY_INVALID_PROVIDER,
    );
  }
  return deposit;
};

export default {
  createVnpayUrl,
  vnpayIpn,
  vnpayReturn,
  getVnpayPolicy,
  assertDepositPayable,
};
