/**
 * @file vnpayIpnService.js
 * @description KAN-99 — handles one VNPay IPN webhook end to end.
 *
 *   1. Verify HMAC-SHA512 signature.
 *   2. Look up the Deposit by vnpTxnRef.
 *   3. Check (deposit.depositAmount × 100) === vnp_Amount to stop tampered amounts.
 *   4. Idempotency: if the same (txnRef, transactionNo) with `verifiedSignature:true`
 *      is already in `vnpay_ipn_logs`, replay the cached response instead of touching
 *      the Deposit again.
 *   5. If the VNPay response code is 00/00 (success + completed), promote
 *      PENDING_PAYMENT / UNPAID → DEPOSIT_PAID / DEPOSIT_PAID.
 *      Any other response (24 customer-cancel, 51 insufficient, 97 bad hash, …)
 *      leaves the deposit untouched; only the log entry is written.
 *   6. Record the IPN log with the chosen outcome so the webhook can be retried
 *      safely.
 *
 * All DB writes go through conditional updates — concurrent IPNs for the same
 * deposit are serialised at the storage layer, the slower one gets `DUPLICATE`.
 *
 * The function ALWAYS returns `{ rspCode, message, outcome }` and never throws:
 * VNPay interprets an HTTP 200 with `RspCode:"00"` as "confirmed", any other
 * shape causes retries that would double-charge audit logs.
 */

import mongoose from 'mongoose';
import Deposit from '../models/Deposit.js';
import VnpayIpnLog from '../models/VnpayIpnLog.js';
import ActivityLog from '../models/ActivityLog.js';
import logger from '../utils/logger.js';
import { parseVnpDate, summariseIpnForLog, verifySignature } from './vnpayService.js';
import {
  DepositStatus,
  DepositPaymentStatus,
  DepositAction,
  IpnOutcome,
  VnpayRspCode,
  getDepositSettings,
} from '../constants/depositConstants.js';
import { ActivityEventType } from '../constants/appConstants.js';

const RESPONSE_SHAPE = Object.freeze({
  [VnpayRspCode.SUCCESS]:           'Confirm Success',
  [VnpayRspCode.ORDER_NOT_FOUND]:   'Order not found',
  [VnpayRspCode.ORDER_ALREADY_CFM]: 'Order already confirmed',
  [VnpayRspCode.INVALID_AMOUNT]:    'Invalid amount',
  [VnpayRspCode.INVALID_SIGNATURE]: 'Invalid signature',
  [VnpayRspCode.UNKNOWN_ERROR]:     'Unknown error',
});

const makeResponse = (rspCode) => ({ RspCode: rspCode, Message: RESPONSE_SHAPE[rspCode] || 'Unknown' });

const nowDate = () => new Date();

const historyEntry = (action, note) => ({
  action,
  at: nowDate(),
  actorId: null,
  result: 'SUCCESS',
  note: note ? String(note).slice(0, 500) : null,
});

/**
 * Build a log row + persist it. Swallows unique-index violations so the caller
 * can keep handling IPNs even if two retries race — we already logged once.
 *
 * @param {object} params
 * @returns {Promise<void>}
 */
const persistLog = async (params) => {
  try {
    await VnpayIpnLog.create(params);
  } catch (error) {
    if (error?.code === 11000) {
      logger?.debug?.('[vnpay-ipn] duplicate log write ignored', { vnpTxnRef: params.vnpTxnRef });
      return;
    }
    logger?.warn?.('[vnpay-ipn] log write failed', { error: error?.message });
  }
};

/**
 * Apply the state transition PENDING_PAYMENT / UNPAID → DEPOSIT_PAID / DEPOSIT_PAID.
 * Returns the updated deposit when the write succeeded, or null when another
 * writer already moved the state.
 *
 * @param {object} args
 * @param {string} args.depositId
 * @param {string} args.vnpTxnRef   must match what the deposit stored (defence in depth)
 * @param {Record<string, string>} args.query
 * @returns {Promise<object|null>}
 */
const promoteDepositToPaid = async ({ depositId, vnpTxnRef, query }) => {
  const settings = getDepositSettings();
  const now = nowDate();
  const payDate = parseVnpDate(query.vnp_PayDate) || now;

  const set = {
    status: DepositStatus.DEPOSIT_PAID,
    paymentStatus: DepositPaymentStatus.DEPOSIT_PAID,
    paidAt: now,
    paymentConfirmedBy: null,
    paymentReference: query.vnp_TransactionNo || null,
    paymentNote: `VNPay sandbox • Bank ${query.vnp_BankCode || 'N/A'} • Code ${query.vnp_ResponseCode || 'N/A'}`,
    vnpayTransactionNo: query.vnp_TransactionNo || null,
    vnpayBankCode: query.vnp_BankCode || null,
    vnpayPayDate: payDate,
    vnpayResponseCode: query.vnp_ResponseCode || null,
  };
  if (settings.paidHoldMs > 0) {
    set.expiresAt = new Date(now.getTime() + settings.paidHoldMs);
  }

  const push = {
    history: historyEntry(
      DepositAction.VNPAY_IPN_APPLIED,
      `TxnNo ${query.vnp_TransactionNo || 'N/A'} • Bank ${query.vnp_BankCode || 'N/A'}`,
    ),
  };

  return Deposit.findOneAndUpdate(
    {
      _id: depositId,
      status: DepositStatus.PENDING_PAYMENT,
      paymentStatus: DepositPaymentStatus.UNPAID,
      vnpayTxnRef: vnpTxnRef,
    },
    { $set: set, $push: push },
    { new: true },
  ).lean();
};

const writeAuditRejected = async (deposit, reason, vnpTxnRef) => {
  if (!deposit) return;
  try {
    await Deposit.updateOne(
      { _id: deposit._id },
      {
        $set: { reviewRequired: true, reviewNote: reason.slice(0, 500) },
        $push: {
          history: historyEntry(
            DepositAction.VNPAY_IPN_REJECTED,
            `TxnRef ${vnpTxnRef} • ${reason}`,
          ),
        },
      },
    );
  } catch (error) {
    logger?.warn?.('[vnpay-ipn] audit flag failed', { error: error?.message });
  }
};

const writeActivityLog = async (deposit, outcome, query) => {
  try {
    await ActivityLog.create({
      eventType: ActivityEventType.CAR_UPDATED,
      performedBy: null,
      performedByEmail: null,
      targetModel: 'Car',
      targetId: deposit?.carId ?? null,
      targetCode: deposit?.carVehicleCode ?? null,
      summary: `VNPay IPN ${outcome} • Deposit ${deposit?.depositCode ?? 'N/A'} • TxnNo ${query.vnp_TransactionNo || 'N/A'}`.slice(0, 500),
      metadata: {
        module: 'DEPOSIT',
        action: outcome === IpnOutcome.APPLIED
          ? DepositAction.VNPAY_IPN_APPLIED
          : DepositAction.VNPAY_IPN_REJECTED,
        source: 'VNPAY',
        result: outcome,
        depositId: deposit?._id ? String(deposit._id) : null,
        depositCode: deposit?.depositCode ?? null,
        vnpTransactionNo: query.vnp_TransactionNo || null,
        vnpResponseCode: query.vnp_ResponseCode || null,
        vnpBankCode: query.vnp_BankCode || null,
        vnpAmount: query.vnp_Amount ? Number(query.vnp_Amount) : null,
      },
    });
  } catch (error) {
    logger?.warn?.('[vnpay-ipn] activity log write failed', { error: error?.message });
  }
};

/**
 * Process one IPN request.
 *
 * @param {object} args
 * @param {Record<string, string>} args.query  the full `req.query` from VNPay
 * @param {string|null} [args.ipAddress]
 * @returns {Promise<{ rspCode: string, message: string, outcome: string, deposit: object|null }>}
 */
export const handleVnpayIpn = async ({ query, ipAddress = null }) => {
  const startedAt = Date.now();
  const vnpTxnRef = typeof query?.vnp_TxnRef === 'string' ? query.vnp_TxnRef : null;
  const vnpTransactionNo = typeof query?.vnp_TransactionNo === 'string' ? query.vnp_TransactionNo : null;
  const summary = summariseIpnForLog(query || {});
  logger?.info?.('[vnpay-ipn] received', { ip: ipAddress, ...summary });

  // 1 — Signature
  const signatureOk = verifySignature(query || {});
  if (!signatureOk) {
    const response = makeResponse(VnpayRspCode.INVALID_SIGNATURE);
    await persistLog({
      vnpTxnRef: vnpTxnRef || 'UNKNOWN',
      vnpTransactionNo,
      vnpResponseCode: query?.vnp_ResponseCode || null,
      vnpTransactionStatus: query?.vnp_TransactionStatus || null,
      vnpAmount: query?.vnp_Amount ? Number(query.vnp_Amount) : null,
      vnpBankCode: query?.vnp_BankCode || null,
      vnpPayDate: query?.vnp_PayDate || null,
      vnpSecureHash: query?.vnp_SecureHash || null,
      rawQuery: query || null,
      depositId: null,
      verifiedSignature: false,
      outcome: IpnOutcome.INVALID_SIGNATURE,
      responseToVnpay: response,
      processedMs: Date.now() - startedAt,
      ipAddress,
    });
    return { ...response, outcome: IpnOutcome.INVALID_SIGNATURE, deposit: null };
  }

  if (!vnpTxnRef) {
    const response = makeResponse(VnpayRspCode.ORDER_NOT_FOUND);
    await persistLog({
      vnpTxnRef: 'UNKNOWN',
      vnpTransactionNo,
      rawQuery: query || null,
      verifiedSignature: true,
      outcome: IpnOutcome.DEPOSIT_NOT_FOUND,
      responseToVnpay: response,
      processedMs: Date.now() - startedAt,
      ipAddress,
    });
    return { ...response, outcome: IpnOutcome.DEPOSIT_NOT_FOUND, deposit: null };
  }

  // 2 — Lookup deposit (do not change its state yet)
  const deposit = await Deposit.findOne({ vnpayTxnRef: vnpTxnRef }).lean();
  if (!deposit) {
    const response = makeResponse(VnpayRspCode.ORDER_NOT_FOUND);
    await persistLog({
      vnpTxnRef,
      vnpTransactionNo,
      vnpResponseCode: query?.vnp_ResponseCode || null,
      vnpAmount: query?.vnp_Amount ? Number(query.vnp_Amount) : null,
      rawQuery: query,
      depositId: null,
      verifiedSignature: true,
      outcome: IpnOutcome.DEPOSIT_NOT_FOUND,
      responseToVnpay: response,
      processedMs: Date.now() - startedAt,
      ipAddress,
    });
    return { ...response, outcome: IpnOutcome.DEPOSIT_NOT_FOUND, deposit: null };
  }

  // 3 — Idempotency: has this exact IPN already been applied?
  if (vnpTransactionNo) {
    const previous = await VnpayIpnLog.findOne({
      vnpTxnRef,
      vnpTransactionNo,
      verifiedSignature: true,
    }).lean();
    if (previous) {
      logger?.info?.('[vnpay-ipn] duplicate replay', { vnpTxnRef, vnpTransactionNo });
      const response = previous.responseToVnpay && typeof previous.responseToVnpay === 'object'
        ? previous.responseToVnpay
        : makeResponse(VnpayRspCode.SUCCESS);
      await persistLog({
        vnpTxnRef,
        vnpTransactionNo,
        vnpResponseCode: query?.vnp_ResponseCode || null,
        vnpAmount: query?.vnp_Amount ? Number(query.vnp_Amount) : null,
        rawQuery: query,
        depositId: deposit._id,
        verifiedSignature: true,
        outcome: IpnOutcome.DUPLICATE,
        responseToVnpay: response,
        processedMs: Date.now() - startedAt,
        ipAddress,
      });
      return { ...response, outcome: IpnOutcome.DUPLICATE, deposit };
    }
  }

  // 4 — Amount check (× 100 convention)
  const expectedAmount = Math.round(Number(deposit.depositAmount) * 100);
  const reportedAmount = Number(query?.vnp_Amount);
  if (!Number.isFinite(reportedAmount) || reportedAmount !== expectedAmount) {
    const response = makeResponse(VnpayRspCode.INVALID_AMOUNT);
    await persistLog({
      vnpTxnRef,
      vnpTransactionNo,
      vnpResponseCode: query?.vnp_ResponseCode || null,
      vnpAmount: Number.isFinite(reportedAmount) ? reportedAmount : null,
      rawQuery: query,
      depositId: deposit._id,
      verifiedSignature: true,
      outcome: IpnOutcome.AMOUNT_MISMATCH,
      responseToVnpay: response,
      processedMs: Date.now() - startedAt,
      ipAddress,
    });
    await writeAuditRejected(
      deposit,
      `VNPay reported amount ${reportedAmount || 'n/a'} ≠ expected ${expectedAmount}`,
      vnpTxnRef,
    );
    await writeActivityLog(deposit, IpnOutcome.AMOUNT_MISMATCH, query);
    return { ...response, outcome: IpnOutcome.AMOUNT_MISMATCH, deposit };
  }

  // 5 — Provider-reported failure (customer cancelled, OTP wrong, bank timeout, …)
  const responseCode = String(query?.vnp_ResponseCode || '');
  const transactionStatus = String(query?.vnp_TransactionStatus || '');
  const paymentSucceeded = responseCode === '00' && (transactionStatus === '' || transactionStatus === '00');
  if (!paymentSucceeded) {
    const response = makeResponse(VnpayRspCode.SUCCESS); // ack to VNPay; we chose not to promote
    await persistLog({
      vnpTxnRef,
      vnpTransactionNo,
      vnpResponseCode: responseCode || null,
      vnpTransactionStatus: transactionStatus || null,
      vnpAmount: reportedAmount,
      rawQuery: query,
      depositId: deposit._id,
      verifiedSignature: true,
      outcome: IpnOutcome.PROVIDER_FAILURE,
      responseToVnpay: response,
      processedMs: Date.now() - startedAt,
      ipAddress,
    });
    await writeActivityLog(deposit, IpnOutcome.PROVIDER_FAILURE, query);
    return { ...response, outcome: IpnOutcome.PROVIDER_FAILURE, deposit };
  }

  // 6 — Promote the deposit; a concurrent writer may have moved it already.
  let updatedDeposit = null;
  try {
    updatedDeposit = await promoteDepositToPaid({
      depositId: deposit._id,
      vnpTxnRef,
      query,
    });
  } catch (error) {
    logger?.error?.('[vnpay-ipn] promote failed', { error: error?.message, vnpTxnRef });
    const response = makeResponse(VnpayRspCode.UNKNOWN_ERROR);
    await persistLog({
      vnpTxnRef,
      vnpTransactionNo,
      vnpResponseCode: responseCode || null,
      vnpAmount: reportedAmount,
      rawQuery: query,
      depositId: deposit._id,
      verifiedSignature: true,
      outcome: IpnOutcome.DEPOSIT_INVALID_STATE,
      responseToVnpay: response,
      processedMs: Date.now() - startedAt,
      ipAddress,
    });
    return { ...response, outcome: IpnOutcome.DEPOSIT_INVALID_STATE, deposit };
  }

  if (!updatedDeposit) {
    const response = makeResponse(VnpayRspCode.ORDER_ALREADY_CFM);
    await persistLog({
      vnpTxnRef,
      vnpTransactionNo,
      vnpResponseCode: responseCode || null,
      vnpAmount: reportedAmount,
      rawQuery: query,
      depositId: deposit._id,
      verifiedSignature: true,
      outcome: IpnOutcome.DEPOSIT_INVALID_STATE,
      responseToVnpay: response,
      processedMs: Date.now() - startedAt,
      ipAddress,
    });
    await writeAuditRejected(
      deposit,
      `VNPay IPN arrived after deposit left PENDING_PAYMENT state`,
      vnpTxnRef,
    );
    await writeActivityLog(deposit, IpnOutcome.DEPOSIT_INVALID_STATE, query);
    return { ...response, outcome: IpnOutcome.DEPOSIT_INVALID_STATE, deposit };
  }

  const response = makeResponse(VnpayRspCode.SUCCESS);
  await persistLog({
    vnpTxnRef,
    vnpTransactionNo,
    vnpResponseCode: responseCode || null,
    vnpTransactionStatus: transactionStatus || null,
    vnpAmount: reportedAmount,
    vnpBankCode: query?.vnp_BankCode || null,
    vnpPayDate: query?.vnp_PayDate || null,
    vnpSecureHash: query?.vnp_SecureHash || null,
    rawQuery: query,
    depositId: updatedDeposit._id,
    verifiedSignature: true,
    outcome: IpnOutcome.APPLIED,
    responseToVnpay: response,
    processedMs: Date.now() - startedAt,
    ipAddress,
  });
  await writeActivityLog(updatedDeposit, IpnOutcome.APPLIED, query);
  logger?.info?.('[vnpay-ipn] applied', {
    vnpTxnRef, vnpTransactionNo, depositCode: updatedDeposit.depositCode,
  });
  return { ...response, outcome: IpnOutcome.APPLIED, deposit: updatedDeposit };
};

export default { handleVnpayIpn };
