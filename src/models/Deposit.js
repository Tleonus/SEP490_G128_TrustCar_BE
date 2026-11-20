/**
 * @file Deposit.js
 * @description KAN-22 – Online deposit that holds (RESERVED) one car for a limited time.
 *
 * Collection: `deposits` (new – not in the original ERD; created by
 * src/seeders/createDepositsCollection.js or by Mongoose on first use).
 *
 * ERD-style relations (same naming as sale-record.model.js):
 *   Deposit N — 1 Car       (carId)       – a car has many deposits over time
 *   Deposit N — 1 User      (userId)      – the customer account that placed it (from JWT)
 *   Deposit N — 1 Customer  (customerId)  – the showroom customer profile linked to that account
 *   Deposit N — 0..1 User   (paymentConfirmedBy / completedBy / cancelledBy / refundedBy) – staff audit
 *
 * Two independent state fields:
 *   status        – hold lifecycle: PENDING_PAYMENT → DEPOSIT_PAID → COMPLETED | EXPIRED | CANCELLED
 *   paymentStatus – money: UNPAID → DEPOSIT_PAID → FULLY_PAID, or → REFUND_PENDING → REFUNDED
 *
 * Integrity rules:
 * - holdActive = true while the deposit holds the car (PENDING_PAYMENT / DEPOSIT_PAID).
 *   Unique partial index { carId } where holdActive = true → at most ONE active hold per car,
 *   enforced by MongoDB itself.
 * - carStatusChangedAt = the Car.statusChangedAt written when the car was reserved. The car is
 *   only released / sold by this module while that stamp still matches, so a car changed by
 *   another flow is never touched.
 * - history is append-only (who / what / when / result).
 */

import mongoose from 'mongoose';
import { DepositStatus, DepositPaymentStatus, DepositAction, PaymentProvider } from '../constants/depositConstants.js';

const { Schema } = mongoose;

const DepositHistorySchema = new Schema(
  {
    action:  { type: String, enum: Object.values(DepositAction), required: true },
    at:      { type: Date, default: () => new Date() },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // null = system job
    result:  { type: String, enum: ['SUCCESS'], default: 'SUCCESS' },
    note:    { type: String, maxlength: 500, default: null },
  },
  { _id: false, versionKey: false },
);

const DepositSchema = new Schema(
  {
    depositCode: { type: String, required: true, trim: true, uppercase: true },

    // ── Relations ───────────────────────────────────────────────────────
    carId:      { type: Schema.Types.ObjectId, ref: 'Car', required: true },
    userId:     { type: Schema.Types.ObjectId, ref: 'User', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },

    // ── Snapshots at deposit time (car data may change later) ───────────
    carVehicleCode:   { type: String, default: null },
    carTitle:         { type: String, maxlength: 300, default: null },
    carPriceSnapshot: { type: Number, required: true, min: 0 },

    // ── Money ───────────────────────────────────────────────────────────
    depositAmount: { type: Number, required: true, min: 1 },
    currency:      { type: String, enum: ['VND'], default: 'VND' },

    // ── State ───────────────────────────────────────────────────────────
    status:        { type: String, enum: Object.values(DepositStatus), default: DepositStatus.PENDING_PAYMENT, required: true },
    paymentStatus: { type: String, enum: Object.values(DepositPaymentStatus), default: DepositPaymentStatus.UNPAID, required: true },
    holdActive:    { type: Boolean, default: true },

    // ── Timeline ────────────────────────────────────────────────────────
    // createdAt (timestamps) = request time; reservedAt = car became RESERVED (same request)
    reservedAt:         { type: Date, required: true },
    expiresAt:          { type: Date, required: true },
    carStatusChangedAt: { type: Date, required: true },

    // Deposit payment verified by staff (bank transfer / cash at showroom)
    paidAt:             { type: Date, default: null },
    paymentConfirmedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    paymentReference:   { type: String, trim: true, maxlength: 100, default: null },
    paymentNote:        { type: String, trim: true, maxlength: 500, default: null },

    // Full payment of the car verified by staff → car SOLD
    completedAt:              { type: Date, default: null },
    completedBy:              { type: Schema.Types.ObjectId, ref: 'User', default: null },
    fullPaymentReference:     { type: String, trim: true, maxlength: 100, default: null },
    fullPaymentNote:          { type: String, trim: true, maxlength: 500, default: null },

    cancelledAt:  { type: Date, default: null },
    cancelledBy:  { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, trim: true, maxlength: 500, default: null },

    expiredAt: { type: Date, default: null },

    refundedAt:      { type: Date, default: null },
    refundedBy:      { type: Schema.Types.ObjectId, ref: 'User', default: null },
    refundAmount:    { type: Number, min: 0, default: null },
    refundReference: { type: String, trim: true, maxlength: 100, default: null },
    refundNote:      { type: String, trim: true, maxlength: 500, default: null },

    // ── VNPay integration (KAN-99) ──────────────────────────────────────
    // paymentProvider is the gateway the customer PICKED (not necessarily paid through).
    // A MANUAL deposit left unpaid stays MANUAL; upgrading to VNPAY on retry re-writes it.
    paymentProvider:    { type: String, enum: Object.values(PaymentProvider), default: PaymentProvider.MANUAL },
    // vnp_TxnRef sent to VNPay. Shape `DEP-{depositCode}-{timestampMs}`. Unique sparse —
    // a MANUAL deposit never sets it, so the index does not conflict.
    vnpayTxnRef:        { type: String, trim: true, maxlength: 100, default: null },
    // vnp_TransactionNo — VNPay's own transaction id, only known after a successful payment.
    vnpayTransactionNo: { type: String, trim: true, maxlength: 50, default: null },
    // vnp_BankCode — the bank the customer actually used (NCB, VCB, …). Used for display only.
    vnpayBankCode:      { type: String, trim: true, maxlength: 20, default: null },
    // vnp_PayDate parsed from yyyyMMddHHmmss (Asia/Ho_Chi_Minh in the sandbox).
    vnpayPayDate:       { type: Date, default: null },
    // vnp_ResponseCode kept verbatim so support can look up VNPay failure codes later.
    vnpayResponseCode:  { type: String, trim: true, maxlength: 10, default: null },

    // true/false once the hold is closed: whether the car went back to AVAILABLE.
    // null while open, or while the release is still pending (picked up by the job).
    carReleasedOnClose: { type: Boolean, default: null },

    // Set when the job closed the hold because the car status was changed outside this
    // flow (e.g. sold through the sales checkout) – staff should double-check it.
    reviewRequired: { type: Boolean, default: false },
    reviewNote:     { type: String, maxlength: 500, default: null },

    history: { type: [DepositHistorySchema], default: [] },
  },
  { collection: 'deposits', timestamps: true, versionKey: false },
);

// ── Indexes (also created explicitly by src/seeders/createDepositsCollection.js) ──
export const DEPOSIT_INDEXES = [
  [{ depositCode: 1 }, { unique: true, name: 'uniq_depositCode' }],
  // DB-level guard: one active hold per car.
  [{ carId: 1 }, { unique: true, partialFilterExpression: { holdActive: true }, name: 'uniq_active_hold_per_car' }],
  [{ carId: 1, createdAt: -1 }, { name: 'car_history' }],
  [{ userId: 1, createdAt: -1 }, { name: 'user_history' }],
  [{ customerId: 1, holdActive: 1 }, { name: 'customer_active_holds' }],
  [{ status: 1, expiresAt: 1 }, { name: 'expiry_scan' }],
  [{ paymentStatus: 1, createdAt: -1 }, { name: 'payment_status_list' }],
  [{ holdActive: 1, reservedAt: 1 }, { name: 'active_holds_reconcile' }],
  // KAN-99: unique sparse — two VNPay URL requests for the SAME deposit reuse the field,
  // the unique constraint only triggers across different deposits.
  [{ vnpayTxnRef: 1 }, { unique: true, sparse: true, name: 'uniq_vnpayTxnRef' }],
];

DEPOSIT_INDEXES.forEach(([keys, options]) => DepositSchema.index(keys, options));

const Deposit = mongoose.models.Deposit || mongoose.model('Deposit', DepositSchema);
export default Deposit;
