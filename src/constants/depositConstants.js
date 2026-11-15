/**
 * @file depositConstants.js
 * @description KAN-22 – Car Deposit & Online Hold. Enumerations, error codes and
 * tunable settings for the deposit module. Kept in a separate file so the shared
 * appConstants.js stays untouched.
 *
 * Money is stored as integer VND (same as Car.price).
 *
 * ── Business assumption (to be confirmed by the business owner) ────────────────
 * Jira: "Nếu sau 24h khách không thanh toán đủ, tự động hủy cọc và đưa xe về AVAILABLE".
 * Implemented literally:
 *   - The hold window starts at reservedAt (when the customer places the deposit request
 *     and the car becomes RESERVED) and lasts DEPOSIT_HOLD_HOURS (24h).
 *   - Before expiresAt the customer must pay the deposit (staff confirms → DEPOSIT_PAID)
 *     AND complete the full payment of the car (staff confirms → COMPLETED, car SOLD).
 *   - If the full payment is not completed by expiresAt the deposit EXPIRES and the car
 *     returns to AVAILABLE. A deposit that was already paid is then marked REFUND_PENDING
 *     (the refund amount is decided by staff according to the deposit contract).
 *   - DEPOSIT_PAID_HOLD_HOURS > 0 switches to the alternative policy: once the deposit is
 *     confirmed, the deadline is extended to paidAt + DEPOSIT_PAID_HOLD_HOURS.
 *
 * Settings can be overridden through environment variables (all optional):
 *   DEPOSIT_HOLD_HOURS               – hold length from reservedAt, default 24
 *   DEPOSIT_PAID_HOLD_HOURS          – extension after deposit is confirmed, default 0 (none)
 *   DEPOSIT_MIN_AMOUNT               – absolute minimum deposit (VND), default 5,000,000
 *   DEPOSIT_MIN_PERCENT              – minimum as % of car price, default 1
 *   DEPOSIT_MAX_PERCENT              – maximum as % of car price, default 30
 *   DEPOSIT_SUGGESTED_PERCENT        – suggested amount as % of car price, default 5
 *   DEPOSIT_MAX_ACTIVE_PER_CUSTOMER  – concurrent holds per customer, default 1
 *   DEPOSIT_JOB_INTERVAL_MS          – expiry scan interval, default 60,000
 *   DEPOSIT_BANK_NAME / DEPOSIT_BANK_ACCOUNT_NUMBER / DEPOSIT_BANK_ACCOUNT_NAME
 *                                    – transfer instructions shown to the customer
 *
 * NOTE: amounts are DEFAULT PROPOSALS – the business owner must confirm them.
 */

/** Deposit lifecycle (business state of the hold). */
export const DepositStatus = Object.freeze({
  PENDING_PAYMENT: 'PENDING_PAYMENT', // Car held; waiting for the deposit transfer
  DEPOSIT_PAID:    'DEPOSIT_PAID',    // Staff verified the deposit; car still held; waiting for full payment
  COMPLETED:       'COMPLETED',       // Full payment verified; car SOLD (terminal)
  EXPIRED:         'EXPIRED',         // Deadline passed without full payment; car released (terminal)
  CANCELLED:       'CANCELLED',       // Cancelled by customer / staff, or car withdrawn by showroom (terminal)
});

/** Money state of the deposit – kept separate from the hold state on purpose. */
export const DepositPaymentStatus = Object.freeze({
  UNPAID:         'UNPAID',         // No money received yet
  DEPOSIT_PAID:   'DEPOSIT_PAID',   // Deposit amount received and verified
  FULLY_PAID:     'FULLY_PAID',     // Full car price received and verified
  REFUND_PENDING: 'REFUND_PENDING', // Hold ended after the deposit was paid – refund to be processed
  REFUNDED:       'REFUNDED',       // Refund recorded by staff (refundAmount may be partial per contract)
});

/** Statuses that still hold the car (at most one per car – unique partial index on holdActive). */
export const ACTIVE_HOLD_STATUSES = Object.freeze([DepositStatus.PENDING_PAYMENT, DepositStatus.DEPOSIT_PAID]);

/** Actions written to Deposit.history and to ActivityLog metadata.action. */
export const DepositAction = Object.freeze({
  CREATED:           'DEPOSIT_CREATED',
  PAYMENT_CONFIRMED: 'DEPOSIT_PAYMENT_CONFIRMED',
  COMPLETED:         'DEPOSIT_COMPLETED',
  CANCELLED:         'DEPOSIT_CANCELLED',
  EXPIRED:           'DEPOSIT_EXPIRED',
  REFUNDED:          'DEPOSIT_REFUNDED',
  HOLD_RELEASED:     'DEPOSIT_HOLD_RELEASED', // car status changed outside this flow (e.g. sold via another flow)
});

/** Public view of a car's sellability for the hold-status endpoint. */
export const PublicCarState = Object.freeze({
  AVAILABLE:   'AVAILABLE',
  RESERVED:    'RESERVED',
  SOLD:        'SOLD',
  UNAVAILABLE: 'UNAVAILABLE', // any internal status (DRAFT, MAINTENANCE, DELISTED…)
});

/** Stable machine-readable error codes (the FE maps them to Vietnamese text). */
export const DepositErrorCode = Object.freeze({
  CAR_NOT_FOUND:        'DEPOSIT_CAR_NOT_FOUND',
  CAR_ALREADY_RESERVED: 'DEPOSIT_CAR_ALREADY_RESERVED',
  CAR_SOLD:             'DEPOSIT_CAR_SOLD',
  CAR_NOT_AVAILABLE:    'DEPOSIT_CAR_NOT_AVAILABLE',
  CAR_PRICE_CHANGED:    'DEPOSIT_CAR_PRICE_CHANGED',
  CAR_STATE_CONFLICT:   'DEPOSIT_CAR_STATE_CONFLICT',
  AMOUNT_INVALID:       'DEPOSIT_AMOUNT_INVALID',
  LIMIT_REACHED:        'DEPOSIT_LIMIT_REACHED',
  USER_MISMATCH:        'DEPOSIT_USER_MISMATCH',
  PROFILE_INCOMPLETE:   'PROFILE_INCOMPLETE',
  NOT_FOUND:            'DEPOSIT_NOT_FOUND',
  INVALID_STATE:        'DEPOSIT_INVALID_STATE',
  EXPIRED:              'DEPOSIT_EXPIRED',
});

const numberFromEnv = (name, fallback, { min = 0 } = {}) => {
  const raw = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(raw) && raw >= min
    ? raw
    : fallback;
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * Read lazily so dotenv (loaded in server.js) is applied before the first use.
 */
export const getDepositSettings = () => {
  const holdHours = numberFromEnv('DEPOSIT_HOLD_HOURS', 24, { min: 1 });
  const paidHoldHours = numberFromEnv('DEPOSIT_PAID_HOLD_HOURS', 0, { min: 0 });
  return {
    holdHours,
    holdMs:               holdHours * HOUR_MS,
    paidHoldHours,
    paidHoldMs:           paidHoldHours * HOUR_MS,
    minAmount:            numberFromEnv('DEPOSIT_MIN_AMOUNT', 5_000_000, { min: 1 }),
    minPercent:           numberFromEnv('DEPOSIT_MIN_PERCENT', 1),
    maxPercent:           numberFromEnv('DEPOSIT_MAX_PERCENT', 30, { min: 1 }),
    suggestedPercent:     numberFromEnv('DEPOSIT_SUGGESTED_PERCENT', 5, { min: 0 }),
    maxActivePerCustomer: numberFromEnv('DEPOSIT_MAX_ACTIVE_PER_CUSTOMER', 1, { min: 1 }),
    jobIntervalMs:        numberFromEnv('DEPOSIT_JOB_INTERVAL_MS', 60_000, { min: 5_000 }),
    jobBatchSize:         100,
    maxTxAttempts:        4,
    reconcileGraceMs:     5 * 60 * 1000,
  };
};

/** Rounds a VND amount up to the next 100,000 for friendly numbers. */
const roundUpVnd = (value) => Math.ceil(value / 100_000) * 100_000;

/**
 * Deposit amount bounds for a given car price (integer VND).
 * @param {number} carPrice
 */
export const computeDepositPolicy = (carPrice) => {
  const s = getDepositSettings();
  const price = Math.max(0, Math.floor(Number(carPrice) || 0));
  const maxAmount = Math.floor((price * s.maxPercent) / 100);
  const minAmount = Math.min(maxAmount, Math.max(s.minAmount, roundUpVnd((price * s.minPercent) / 100)));
  const suggested = Math.min(maxAmount, Math.max(minAmount, roundUpVnd((price * s.suggestedPercent) / 100)));
  return {
    minAmount,
    maxAmount,
    suggestedAmount: suggested,
    holdHours: s.holdHours,
    paidHoldHours: s.paidHoldHours,
    // What has to be done before the deadline (see the assumption above).
    deadlineCovers: s.paidHoldHours > 0 ? 'DEPOSIT_PAYMENT' : 'FULL_PAYMENT',
  };
};

export default {
  DepositStatus, DepositPaymentStatus, ACTIVE_HOLD_STATUSES, DepositAction, PublicCarState, DepositErrorCode,
  getDepositSettings, computeDepositPolicy,
};
