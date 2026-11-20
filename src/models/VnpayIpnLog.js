/**
 * @file VnpayIpnLog.js
 * @description KAN-99 — idempotency + audit log for every VNPay IPN we ever receive.
 *
 * Each IPN webhook VNPay sends gets ONE log entry describing:
 *   - the raw query string (so we can re-verify later)
 *   - whether the signature verified
 *   - what outcome we picked (APPLIED, DUPLICATE, INVALID_SIGNATURE, …)
 *   - what response we sent back to VNPay
 *
 * Idempotency:
 *   A unique partial index `{ vnpTxnRef, vnpTransactionNo }` where `verifiedSignature:true`
 *   enforces that the same (deposit, VNPay transaction) pair is only APPLIED once — any
 *   retry from VNPay returns the cached response without touching the Deposit.
 *
 * Retention:
 *   `receivedAt` carries a TTL index of 90 days. The Deposit itself keeps a summary via
 *   `paymentReference` + `history[]`, so losing the log entry does not lose audit truth.
 */

import mongoose from 'mongoose';
import { IpnOutcome } from '../constants/depositConstants.js';

const { Schema } = mongoose;

const VnpayIpnLogSchema = new Schema(
  {
    vnpTxnRef:         { type: String, required: true, trim: true, maxlength: 100 },
    vnpTransactionNo:  { type: String, trim: true, maxlength: 50, default: null },
    vnpResponseCode:   { type: String, trim: true, maxlength: 10, default: null },
    vnpTransactionStatus: { type: String, trim: true, maxlength: 10, default: null },
    vnpAmount:         { type: Number, min: 0, default: null }, // raw amount (× 100)
    vnpBankCode:       { type: String, trim: true, maxlength: 20, default: null },
    vnpPayDate:        { type: String, trim: true, maxlength: 20, default: null },
    vnpSecureHash:     { type: String, trim: true, maxlength: 256, default: null },

    rawQuery:          { type: Schema.Types.Mixed, default: null },

    depositId:         { type: Schema.Types.ObjectId, ref: 'Deposit', default: null },

    verifiedSignature: { type: Boolean, default: false },
    outcome:           { type: String, enum: Object.values(IpnOutcome), required: true },
    responseToVnpay:   { type: Schema.Types.Mixed, default: null },

    receivedAt:        { type: Date, default: () => new Date() },
    processedMs:       { type: Number, min: 0, default: null },

    ipAddress:         { type: String, trim: true, maxlength: 60, default: null },
  },
  { collection: 'vnpay_ipn_logs', timestamps: false, versionKey: false },
);

// Dedupe key for APPLIED IPNs only — rejected and duplicate logs may repeat
// (attacker keeps retrying, or VNPay replays the same payload many times).
VnpayIpnLogSchema.index(
  { vnpTxnRef: 1, vnpTransactionNo: 1 },
  { unique: true, partialFilterExpression: { outcome: 'APPLIED' }, name: 'uniq_applied_ipn' },
);
VnpayIpnLogSchema.index({ receivedAt: -1 }, { name: 'ipn_recent' });
VnpayIpnLogSchema.index({ receivedAt: 1 }, { name: 'ipn_ttl', expireAfterSeconds: 60 * 60 * 24 * 90 });

const VnpayIpnLog = mongoose.models.VnpayIpnLog || mongoose.model('VnpayIpnLog', VnpayIpnLogSchema);
export default VnpayIpnLog;
