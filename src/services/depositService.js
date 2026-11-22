/**
 * @file depositService.js
 * @description KAN-22 – Car Deposit & Online Hold business logic.
 *
 * Lifecycle (status / paymentStatus)
 *   create            → PENDING_PAYMENT / UNPAID        car AVAILABLE → RESERVED, expiresAt = reservedAt + 24h
 *   confirm-payment   → DEPOSIT_PAID / DEPOSIT_PAID     staff verified the deposit transfer; car stays RESERVED
 *   complete          → COMPLETED / FULLY_PAID          staff verified the full payment; car RESERVED → SOLD
 *   deadline passed   → EXPIRED / UNPAID|REFUND_PENDING car RESERVED → AVAILABLE (job + lazy check)
 *   cancel            → CANCELLED / UNPAID|REFUND_PENDING car RESERVED → AVAILABLE
 *   refund            → (unchanged) / REFUNDED          staff recorded the refund of a paid deposit
 *
 * Deadline rule (Jira: "sau 24h khách không thanh toán đủ → hủy cọc, xe về AVAILABLE"):
 *   the full payment must be verified before expiresAt; see depositConstants.js for the
 *   documented assumption and the DEPOSIT_PAID_HOLD_HOURS alternative.
 *
 * Concurrency
 *   - Unique partial index { carId } where holdActive = true → one active hold per car (DB level).
 *   - The Deposit is created BEFORE the car is reserved, so a RESERVED car without a deposit
 *     can never be produced by this module.
 *   - Car updates are conditional (status + stamp / price) – the loser of a race gets 409.
 *   - Deposit transitions are conditional on the current status, so expire / cancel /
 *     confirm / complete can never both succeed on the same deposit.
 *   - Replica set: everything inside one transaction. Standalone (current local DB):
 *     ordered conditional updates + compensation; the job reconciles any leftover.
 *
 * userId always comes from the verified JWT (req.user). A userId in the body is only
 * accepted if it equals the signed-in account.
 */

import crypto from 'node:crypto';
import dayjs from 'dayjs';
import { AppError, parsePagination, buildPaginationMeta } from '../utils/apiResponse.js';
import { runDepositAtomic } from '../utils/depositTransaction.js';
import { ActivityEventType, CarStatus, Roles } from '../constants/appConstants.js';
import {
  DepositStatus, DepositPaymentStatus, ACTIVE_HOLD_STATUSES, DepositAction, PublicCarState, DepositErrorCode,
  PaymentProvider,
  getDepositSettings, computeDepositPolicy,
} from '../constants/depositConstants.js';
import repo from '../repositories/depositRepository.js';
import logger from '../utils/logger.js';
import Deposit from '../models/Deposit.js';
import { buildPaymentUrl, generateTxnRef } from './vnpayService.js';
import { assertVnpayEnabled } from '../config/vnpay.js';

const STAFF_ROLES = new Set([Roles.ADMIN, Roles.SALES_STAFF]);
export const isStaff = (user) => STAFF_ROLES.has(user?.roleName);

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const carTitleOf = (car) => [car?.make, car?.model, car?.variant, car?.year].filter(Boolean).join(' ');
const sameTime = (a, b) => a && b && new Date(a).getTime() === new Date(b).getTime();
const isHeldBy = (car, deposit) =>
  Boolean(car && car.status === CarStatus.RESERVED && sameTime(car.statusChangedAt, deposit.carStatusChangedAt));

const toPublicState = (car) => {
  if (!car || car.isActive === false) return PublicCarState.UNAVAILABLE;
  if (car.status === CarStatus.AVAILABLE) return PublicCarState.AVAILABLE;
  if (car.status === CarStatus.RESERVED) return PublicCarState.RESERVED;
  if (car.status === CarStatus.SOLD) return PublicCarState.SOLD;
  return PublicCarState.UNAVAILABLE;
};

const notFound = () => new AppError('Không tìm thấy lượt đặt cọc.', 404, DepositErrorCode.NOT_FOUND);

/** Error for a car that cannot be deposited, based on its current state. */
const unavailableCarError = (car) => {
  if (!car) return new AppError('Không tìm thấy xe.', 404, DepositErrorCode.CAR_NOT_FOUND);
  const state = toPublicState(car);
  if (state === PublicCarState.RESERVED) {
    return new AppError('Xe đang được khách hàng khác giữ chỗ.', 409, DepositErrorCode.CAR_ALREADY_RESERVED);
  }
  if (state === PublicCarState.SOLD) return new AppError('Xe đã được bán.', 409, DepositErrorCode.CAR_SOLD);
  return new AppError('Xe hiện không mở đặt cọc.', 409, DepositErrorCode.CAR_NOT_AVAILABLE);
};

const generateDepositCode = () =>
  `DC-${dayjs().format('YYMMDD')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

const isDuplicateKey = (error, field) =>
  error?.code === 11000 && (!field || Object.keys(error.keyPattern || error.keyValue || {}).includes(field));

const historyEntry = (action, actorId = null, note = null) => ({
  action, actorId, note: note ? String(note).slice(0, 500) : null, at: new Date(), result: 'SUCCESS',
});

/** paymentStatus after the hold ends without a sale. */
const paymentStatusOnClose = (deposit) => (
  deposit.paymentStatus === DepositPaymentStatus.DEPOSIT_PAID ? DepositPaymentStatus.REFUND_PENDING : deposit.paymentStatus
);

/** Bank-transfer instructions (only shown when configured in .env – no secrets in source). */
const paymentInstructionsFor = (deposit) => {
  const bankName = process.env.DEPOSIT_BANK_NAME || null;
  const accountNumber = process.env.DEPOSIT_BANK_ACCOUNT_NUMBER || null;
  const accountName = process.env.DEPOSIT_BANK_ACCOUNT_NAME || null;
  return {
    method: 'BANK_TRANSFER_OR_SHOWROOM',
    transferContent: deposit.depositCode,
    amount: deposit.depositAmount,
    bankName,
    accountNumber,
    accountName,
    configured: Boolean(bankName && accountNumber),
  };
};

// ── DTOs (allowlist) ───────────────────────────────────────────────────────

const id = (value) => (value ? String(value) : null);

/** Deposit as seen by its owner (customer) or staff. */
export const toDepositDto = (deposit, { forStaff = false, customer = null, now = new Date() } = {}) => {
  if (!deposit) return null;
  const active = deposit.holdActive && ACTIVE_HOLD_STATUSES.includes(deposit.status);
  const dto = {
    id: id(deposit._id),
    depositCode: deposit.depositCode,
    carId: id(deposit.carId),
    carVehicleCode: deposit.carVehicleCode,
    carTitle: deposit.carTitle,
    carPrice: deposit.carPriceSnapshot,
    depositAmount: deposit.depositAmount,
    remainingAmount: Math.max(0, (deposit.carPriceSnapshot ?? 0) - (deposit.depositAmount ?? 0)),
    currency: deposit.currency,
    status: deposit.status,
    paymentStatus: deposit.paymentStatus,
    holdActive: Boolean(deposit.holdActive),
    createdAt: deposit.createdAt,
    reservedAt: deposit.reservedAt,
    expiresAt: deposit.expiresAt,
    remainingMs: active ? Math.max(0, new Date(deposit.expiresAt).getTime() - now.getTime()) : null,
    paidAt: deposit.paidAt,
    completedAt: deposit.completedAt,
    cancelledAt: deposit.cancelledAt,
    cancelReason: deposit.cancelReason,
    expiredAt: deposit.expiredAt,
    refundedAt: deposit.refundedAt,
    refundAmount: deposit.refundAmount,
    serverTime: now,
    paymentInstructions: deposit.status === DepositStatus.PENDING_PAYMENT && active ? paymentInstructionsFor(deposit) : null,
  };
  if (forStaff) {
    Object.assign(dto, {
      userId: id(deposit.userId),
      customerId: id(deposit.customerId),
      customer: customer
        ? { fullName: customer.fullName ?? null, phone: customer.phone ?? null, email: customer.email ?? null }
        : null,
      paymentReference: deposit.paymentReference,
      paymentNote: deposit.paymentNote,
      paymentConfirmedBy: id(deposit.paymentConfirmedBy),
      completedBy: id(deposit.completedBy),
      fullPaymentReference: deposit.fullPaymentReference,
      fullPaymentNote: deposit.fullPaymentNote,
      cancelledBy: id(deposit.cancelledBy),
      refundedBy: id(deposit.refundedBy),
      refundReference: deposit.refundReference,
      refundNote: deposit.refundNote,
      carReleasedOnClose: deposit.carReleasedOnClose,
      reviewRequired: Boolean(deposit.reviewRequired),
      reviewNote: deposit.reviewNote,
      history: (deposit.history || []).map((h) => ({
        action: h.action, at: h.at, actorId: id(h.actorId), result: h.result, note: h.note,
      })),
    });
  }
  return dto;
};

/** Public car fields for the hold page (no internal notes, no audit fields). */
const toPublicCarDto = (car) => (car ? {
  _id: id(car._id),
  vehicleCode: car.vehicleCode,
  make: car.make,
  model: car.model,
  variant: car.variant,
  year: car.year,
  bodyType: car.bodyType,
  fuelType: car.fuelType,
  transmission: car.transmission,
  driveType: car.driveType,
  mileage: car.mileage,
  specifications: car.specifications,
  price: car.price,
  status: car.status,
  images: (car.images || []).map((img) => ({ _id: id(img._id), url: img.url, isPrimary: img.isPrimary, caption: img.caption })),
  description: car.description,
  conditionGrade: car.conditionGrade,
  cpoCertificateId: car.cpoCertificateId ?? null,
} : null);

// ── Audit ─────────────────────────────────────────────────────────────────

/**
 * ActivityLog entry (existing model, imported). ActivityEventType has no DEPOSIT_* values
 * (appConstants.js is shared), so CAR_STATUS_CHANGED is used when the car status changes and
 * CAR_UPDATED otherwise; the deposit action is in metadata.action.
 */
const auditEntry = ({ action, actor, deposit, carBefore = null, carAfter = null, summary,
  ipAddress = null, userAgent = null, extra = {} }) => ({
  eventType: carBefore || carAfter ? ActivityEventType.CAR_STATUS_CHANGED : ActivityEventType.CAR_UPDATED,
  performedBy: actor?._id ?? null,
  performedByEmail: actor?.email ?? null,
  targetModel: 'Car',
  targetId: deposit.carId,
  targetCode: deposit.carVehicleCode ?? null,
  changes: carBefore || carAfter ? { before: { status: carBefore }, after: { status: carAfter } } : null,
  summary: String(summary).slice(0, 500),
  ipAddress,
  userAgent,
  metadata: {
    module: 'DEPOSIT',
    action,
    result: 'SUCCESS',
    depositId: id(deposit._id),
    depositCode: deposit.depositCode,
    customerUserId: id(deposit.userId),
    customerId: id(deposit.customerId),
    depositAmount: deposit.depositAmount,
    depositStatus: deposit.status,
    paymentStatus: deposit.paymentStatus,
    reservedAt: deposit.reservedAt,
    expiresAt: deposit.expiresAt,
    ...extra,
  },
});

const runAtomic = (work) => runDepositAtomic(work, { maxAttempts: getDepositSettings().maxTxAttempts });

// ═══════════════════════════════════════════════════════════════════════════
// CREATE DEPOSIT (POST /deposits)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {object} params
 * @param {object} params.user          - req.user (verifyToken + CUSTOMER role)
 * @param {string} params.carId         - ObjectId or vehicleCode
 * @param {number} params.depositAmount - integer VND
 * @param {string} [params.userId]      - optional (Jira contract); must equal the signed-in account
 */
export const createDeposit = async ({ user, carId, depositAmount, userId, paymentProvider, ipAddress, userAgent }) => {
  if (userId && String(userId) !== String(user._id)) {
    throw new AppError('userId không khớp với tài khoản đang đăng nhập.', 403, DepositErrorCode.USER_MISMATCH);
  }
  if (!user?.customer || !(await repo.findActiveCustomer(user.customer))) {
    throw new AppError('Vui lòng hoàn tất hồ sơ trước khi đặt cọc.', 403, DepositErrorCode.PROFILE_INCOMPLETE);
  }

  let car = await repo.findCarByKey(carId);
  if (!car || car.isActive === false) throw unavailableCarError(null);

  // Lazy expiry: a hold that has run out must not block the next customer.
  if (car.status === CarStatus.RESERVED) {
    await expireDueHoldOfCar(car._id);
    car = await repo.findCarById(car._id);
  }
  if (!car || car.status !== CarStatus.AVAILABLE) throw unavailableCarError(car);

  const amount = Number(depositAmount);
  const policy = computeDepositPolicy(car.price);
  if (!Number.isInteger(amount) || policy.maxAmount <= 0 || amount < policy.minAmount || amount > policy.maxAmount) {
    throw new AppError(
      `Số tiền đặt cọc phải từ ${policy.minAmount.toLocaleString('vi-VN')} đến ${policy.maxAmount.toLocaleString('vi-VN')} VND.`,
      422,
      DepositErrorCode.AMOUNT_INVALID,
      [{ field: 'depositAmount', message: 'Out of allowed range.', minAmount: policy.minAmount, maxAmount: policy.maxAmount }],
    );
  }

  // KAN-99: normalise paymentProvider; MANUAL is the legacy default so any
  // client that omits the field keeps the original KAN-22 flow.
  const provider = Object.values(PaymentProvider).includes(paymentProvider)
    ? paymentProvider
    : PaymentProvider.MANUAL;

  const settings = getDepositSettings();

  const work = async (session) => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + settings.holdMs);

    if (session) await repo.touchCustomer(user.customer, session); // serialise one customer's requests

    const active = await repo.countActiveHoldsByCustomer(user.customer, session);
    if (active >= settings.maxActivePerCustomer) {
      throw new AppError(
        `Bạn chỉ có thể giữ tối đa ${settings.maxActivePerCustomer} xe cùng lúc.`,
        409,
        DepositErrorCode.LIMIT_REACHED,
      );
    }

    // 1) Deposit FIRST: the unique partial index { carId, holdActive } is the hard lock.
    let deposit;
    for (let attempt = 1; ; attempt += 1) {
      try {
        deposit = await repo.createDeposit({
          depositCode: generateDepositCode(),
          carId: car._id,
          userId: user._id,
          customerId: user.customer,
          carVehicleCode: car.vehicleCode ?? null,
          carTitle: carTitleOf(car).slice(0, 300),
          carPriceSnapshot: car.price,
          depositAmount: amount,
          currency: 'VND',
          status: DepositStatus.PENDING_PAYMENT,
          paymentStatus: DepositPaymentStatus.UNPAID,
          holdActive: true,
          reservedAt: now,
          expiresAt,
          carStatusChangedAt: now,
          paymentProvider: provider,
          history: [historyEntry(DepositAction.CREATED, user._id, `Deposit ${amount} VND via ${provider}, hold until ${expiresAt.toISOString()}`)],
        }, session);
        break;
      } catch (error) {
        // In a transaction a write error aborts it; a code collision there is retried by the caller.
        if (isDuplicateKey(error, 'depositCode') && !session && attempt < 3) continue;
        if (isDuplicateKey(error, 'carId')) throw unavailableCarError({ ...car, status: CarStatus.RESERVED });
        throw error;
      }
    }

    // 2) Car AVAILABLE → RESERVED, only if nobody changed it since we read it.
    const reserved = await repo.reserveCarIfAvailable({
      carId: car._id, expectedPrice: car.price, userId: user._id, stamp: now, session,
    });
    if (!reserved) {
      if (!session) await repo.deleteUnreservedDeposit(deposit._id); // compensation (no transaction)
      const latest = await repo.findCarById(car._id, session);
      if (latest && latest.status === CarStatus.AVAILABLE && latest.price !== car.price) {
        throw new AppError('Giá xe vừa được cập nhật. Vui lòng tải lại trang và thử lại.', 409, DepositErrorCode.CAR_PRICE_CHANGED);
      }
      throw unavailableCarError(latest);
    }

    // 3) Audit: who, which car, amount, when (same transaction when available).
    await repo.writeAudit(auditEntry({
      action: DepositAction.CREATED,
      actor: user,
      deposit,
      carBefore: CarStatus.AVAILABLE,
      carAfter: CarStatus.RESERVED,
      summary: `Online deposit ${deposit.depositCode} (${amount} VND): AVAILABLE → RESERVED until ${expiresAt.toISOString()}`,
      ipAddress,
      userAgent,
    }), session);

    return deposit;
  };

  const deposit = await runAtomic(work);
  logger.info(`[deposit] ${deposit.depositCode} created for car ${deposit.carVehicleCode || deposit.carId}`);
  return toDepositDto(deposit);
};

// ═══════════════════════════════════════════════════════════════════════════
// CLOSE A HOLD WITHOUT SALE (expire / cancel) – shared
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Moves an active deposit to EXPIRED / CANCELLED and releases the car if it is still held by it.
 * Ordering (no-transaction mode): deposit first (stops other transitions), then the car; a crash
 * in between leaves carReleasedOnClose = null, which the job finishes.
 * @returns {Promise<object|null>} closed deposit, or null when it was no longer in `fromStatuses`.
 */
const closeHold = async ({ depositId, fromStatuses, toStatus, action, actor = null, reason = null,
  extraFilter = {}, ipAddress = null, userAgent = null }) => {
  const current = await repo.findDepositById(depositId);
  if (!current || !current.holdActive || !fromStatuses.includes(current.status)) return null;

  const work = async (session) => {
    const now = new Date();
    const set = {
      status: toStatus,
      paymentStatus: paymentStatusOnClose(current),
      holdActive: false,
      carReleasedOnClose: null,
    };
    if (toStatus === DepositStatus.EXPIRED) {
      set.expiredAt = now;
      set.cancelledAt = now; // "thời điểm hủy hoặc hết hạn"
      set.cancelReason = reason;
    }
    if (toStatus === DepositStatus.CANCELLED) {
      set.cancelledAt = now;
      set.cancelledBy = actor?._id ?? null;
      set.cancelReason = reason;
    }

    const deposit = await repo.transitionDeposit({
      id: depositId,
      fromStatuses: [current.status],
      extraFilter: { holdActive: true, paymentStatus: current.paymentStatus, ...extraFilter },
      set,
      historyEntry: historyEntry(action, actor?._id ?? null, reason),
      session,
    });
    if (!deposit) return null;

    const released = await repo.releaseCarIfHeldBy({
      carId: deposit.carId, stamp: deposit.carStatusChangedAt, actorId: actor?._id ?? null, now, session,
    });
    await repo.markCarReleased(deposit._id, released, session);
    deposit.carReleasedOnClose = released;

    await repo.writeAudit(auditEntry({
      action,
      actor,
      deposit,
      carBefore: released ? CarStatus.RESERVED : null,
      carAfter: released ? CarStatus.AVAILABLE : null,
      summary: `Deposit ${deposit.depositCode} ${toStatus}`
        + (released ? ': RESERVED → AVAILABLE' : ' (car status already changed – not released)'),
      ipAddress,
      userAgent,
      extra: { reason, carReleased: released },
    }), session);

    return deposit;
  };

  return runAtomic(work);
};

/** Expires one deposit if it is still active and past its deadline (full payment not completed). */
export const expireDeposit = (depositId, now = new Date()) => closeHold({
  depositId,
  fromStatuses: ACTIVE_HOLD_STATUSES,
  toStatus: DepositStatus.EXPIRED,
  action: DepositAction.EXPIRED,
  reason: 'Hết thời gian giữ xe mà chưa hoàn tất thanh toán.',
  extraFilter: { expiresAt: { $lte: now } },
});

/** Lazy expiry used by read paths, so the UI sees the real state when the countdown ends. */
export const expireDueHoldOfCar = async (carId) => {
  const hold = await repo.findActiveHoldByCar(carId);
  if (hold && new Date(hold.expiresAt) <= new Date()) {
    try {
      await expireDeposit(hold._id);
    } catch (error) {
      logger.error(`[deposit] lazy expiry of ${hold.depositCode} failed: ${error.message}`);
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// CANCEL (customer: own unpaid hold; staff: any active hold)
// ═══════════════════════════════════════════════════════════════════════════

export const cancelDeposit = async ({ user, depositId, reason, ipAddress, userAgent }) => {
  const deposit = await repo.findDepositById(depositId);
  const staff = isStaff(user);
  if (!deposit || (!staff && String(deposit.userId) !== String(user._id))) throw notFound();

  // A customer may only cancel an unpaid hold; once money is involved staff must handle it.
  const allowed = staff ? ACTIVE_HOLD_STATUSES : [DepositStatus.PENDING_PAYMENT];
  if (!deposit.holdActive || !allowed.includes(deposit.status)) {
    throw new AppError(
      staff ? 'Lượt đặt cọc đã kết thúc.' : 'Chỉ có thể tự hủy lượt giữ xe chưa thanh toán cọc. Vui lòng liên hệ TrustCar.',
      409,
      DepositErrorCode.INVALID_STATE,
    );
  }

  const closed = await closeHold({
    depositId,
    fromStatuses: allowed,
    toStatus: DepositStatus.CANCELLED,
    action: DepositAction.CANCELLED,
    actor: user,
    reason: reason || (staff ? 'Nhân viên hủy lượt giữ xe.' : 'Khách hàng hủy lượt giữ xe.'),
    ipAddress,
    userAgent,
  });
  if (!closed) throw new AppError('Trạng thái đặt cọc vừa thay đổi. Vui lòng tải lại.', 409, DepositErrorCode.INVALID_STATE);
  return toDepositDto(closed, { forStaff: staff });
};

// ═══════════════════════════════════════════════════════════════════════════
// STAFF: CONFIRM DEPOSIT PAYMENT / COMPLETE FULL PAYMENT / RECORD REFUND
// ═══════════════════════════════════════════════════════════════════════════

/** Throws the right error after a conditional transition did not match. */
const explainFailedTransition = async (depositId, expected) => {
  const current = await repo.findDepositById(depositId);
  if (!current) throw notFound();
  if (current.holdActive && new Date(current.expiresAt) <= new Date()) {
    await expireDueHoldOfCar(current.carId);
    throw new AppError('Lượt giữ xe đã hết hạn.', 409, DepositErrorCode.EXPIRED);
  }
  throw new AppError(
    `Không thể thực hiện: đặt cọc đang ở trạng thái ${current.status} / ${current.paymentStatus} (cần ${expected}).`,
    409,
    DepositErrorCode.INVALID_STATE,
  );
};

/** Ensures the car is still RESERVED by this deposit before staff acts on it. */
const assertCarHeld = async (deposit) => {
  const car = await repo.findCarById(deposit.carId);
  if (!isHeldBy(car, deposit)) {
    throw new AppError(
      'Trạng thái xe đã bị thay đổi ngoài luồng đặt cọc. Hệ thống sẽ tự đối soát lượt giữ này.',
      409,
      DepositErrorCode.CAR_STATE_CONFLICT,
    );
  }
};

/** Staff verified the deposit transfer → DEPOSIT_PAID. Car stays RESERVED. */
export const confirmDepositPayment = async ({ user, depositId, paymentReference, note, ipAddress, userAgent }) => {
  const existing = await repo.findDepositById(depositId);
  if (!existing) throw notFound();
  if (existing.status === DepositStatus.PENDING_PAYMENT && existing.holdActive) await assertCarHeld(existing);

  const settings = getDepositSettings();
  const work = async (session) => {
    const now = new Date();
    const set = {
      status: DepositStatus.DEPOSIT_PAID,
      paymentStatus: DepositPaymentStatus.DEPOSIT_PAID,
      paidAt: now,
      paymentConfirmedBy: user._id,
      paymentReference: paymentReference || null,
      paymentNote: note || null,
    };
    // Optional policy: extend the deadline once the deposit is secured.
    if (settings.paidHoldMs > 0) {
      const extended = now.getTime() + settings.paidHoldMs;
      if (extended > new Date(existing.expiresAt).getTime()) set.expiresAt = new Date(extended);
    }

    const deposit = await repo.transitionDeposit({
      id: depositId,
      fromStatuses: [DepositStatus.PENDING_PAYMENT],
      extraFilter: { holdActive: true, paymentStatus: DepositPaymentStatus.UNPAID, expiresAt: { $gt: now } },
      set,
      historyEntry: historyEntry(DepositAction.PAYMENT_CONFIRMED, user._id, paymentReference || null),
      session,
    });
    if (!deposit) return null;

    await repo.writeAudit(auditEntry({
      action: DepositAction.PAYMENT_CONFIRMED,
      actor: user,
      deposit,
      summary: `Deposit ${deposit.depositCode}: deposit payment verified by staff`,
      ipAddress,
      userAgent,
      extra: { paymentReference: paymentReference || null, paidAt: now },
    }), session);
    return deposit;
  };

  const deposit = await runAtomic(work);
  if (!deposit) await explainFailedTransition(depositId, 'PENDING_PAYMENT / UNPAID');
  return toDepositDto(deposit, { forStaff: true });
};

/**
 * Staff verified the FULL payment of the car before the deadline → COMPLETED / FULLY_PAID,
 * car RESERVED → SOLD. The deposit is moved first (so the expiry job can no longer touch it),
 * then the car; if the car cannot be sold the deposit change is rolled back.
 */
export const completeDeposit = async ({ user, depositId, paymentReference, note, ipAddress, userAgent }) => {
  const existing = await repo.findDepositById(depositId);
  if (!existing) throw notFound();
  if (existing.holdActive && ACTIVE_HOLD_STATUSES.includes(existing.status)) await assertCarHeld(existing);

  const work = async (session) => {
    const now = new Date();
    const deposit = await repo.transitionDeposit({
      id: depositId,
      fromStatuses: ACTIVE_HOLD_STATUSES,
      extraFilter: { holdActive: true, expiresAt: { $gt: now } },
      set: {
        status: DepositStatus.COMPLETED,
        paymentStatus: DepositPaymentStatus.FULLY_PAID,
        holdActive: false,
        completedAt: now,
        completedBy: user._id,
        fullPaymentReference: paymentReference || null,
        fullPaymentNote: note || null,
        carReleasedOnClose: false,
        // Full payment includes the deposit: record it if it was not confirmed separately.
        ...(existing.paidAt ? {} : { paidAt: now, paymentConfirmedBy: user._id }),
      },
      historyEntry: historyEntry(DepositAction.COMPLETED, user._id, paymentReference || null),
      session,
    });
    if (!deposit) return null;

    const sold = await repo.sellCarIfHeldBy({ carId: deposit.carId, stamp: deposit.carStatusChangedAt, actorId: user._id, now, session });
    if (!sold) {
      if (!session) {
        await repo.revertDeposit({
          id: depositId,
          expectFilter: { status: DepositStatus.COMPLETED, completedAt: now },
          set: {
            status: existing.status,
            paymentStatus: existing.paymentStatus,
            holdActive: true,
            completedAt: null,
            completedBy: null,
            fullPaymentReference: null,
            fullPaymentNote: null,
            carReleasedOnClose: null,
            paidAt: existing.paidAt ?? null,
            paymentConfirmedBy: existing.paymentConfirmedBy ?? null,
          },
        });
      }
      throw new AppError('Không thể chuyển xe sang SOLD: trạng thái xe đã thay đổi.', 409, DepositErrorCode.CAR_STATE_CONFLICT);
    }

    await repo.writeAudit(auditEntry({
      action: DepositAction.COMPLETED,
      actor: user,
      deposit,
      carBefore: CarStatus.RESERVED,
      carAfter: CarStatus.SOLD,
      summary: `Deposit ${deposit.depositCode}: full payment verified – RESERVED → SOLD`,
      ipAddress,
      userAgent,
      extra: { paymentReference: paymentReference || null, completedAt: now },
    }), session);
    return deposit;
  };

  const deposit = await runAtomic(work);
  if (!deposit) await explainFailedTransition(depositId, 'PENDING_PAYMENT hoặc DEPOSIT_PAID, chưa hết hạn');
  return toDepositDto(deposit, { forStaff: true });
};

/** Staff recorded the refund of a deposit that was paid but the hold ended without a sale. */
export const refundDeposit = async ({ user, depositId, refundAmount, refundReference, note, ipAddress, userAgent }) => {
  const existing = await repo.findDepositById(depositId);
  if (!existing) throw notFound();
  if (existing.paymentStatus !== DepositPaymentStatus.REFUND_PENDING) {
    throw new AppError('Chỉ ghi nhận hoàn cọc cho lượt đặt cọc đang chờ hoàn tiền.', 409, DepositErrorCode.INVALID_STATE);
  }
  const amount = Number(refundAmount);
  if (!Number.isInteger(amount) || amount < 0 || amount > existing.depositAmount) {
    throw new AppError(`Số tiền hoàn phải từ 0 đến ${existing.depositAmount.toLocaleString('vi-VN')} VND.`, 422, DepositErrorCode.AMOUNT_INVALID);
  }

  const work = async (session) => {
    const now = new Date();
    const deposit = await repo.transitionDeposit({
      id: depositId,
      fromStatuses: [DepositStatus.EXPIRED, DepositStatus.CANCELLED],
      extraFilter: { paymentStatus: DepositPaymentStatus.REFUND_PENDING },
      set: {
        paymentStatus: DepositPaymentStatus.REFUNDED,
        refundedAt: now,
        refundedBy: user._id,
        refundAmount: amount,
        refundReference: refundReference || null,
        refundNote: note || null,
      },
      historyEntry: historyEntry(DepositAction.REFUNDED, user._id, `${amount} VND ${refundReference || ''}`.trim()),
      session,
    });
    if (!deposit) return null;
    await repo.writeAudit(auditEntry({
      action: DepositAction.REFUNDED,
      actor: user,
      deposit,
      summary: `Deposit ${deposit.depositCode}: refund of ${amount} VND recorded`,
      ipAddress,
      userAgent,
      extra: { refundAmount: amount, refundReference: refundReference || null },
    }), session);
    return deposit;
  };

  const deposit = await runAtomic(work);
  if (!deposit) await explainFailedTransition(depositId, 'REFUND_PENDING');
  return toDepositDto(deposit, { forStaff: true });
};

// ═══════════════════════════════════════════════════════════════════════════
// READS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Public hold status of a car (no personal data of whoever holds it).
 * @param {string} carKey - ObjectId or vehicleCode
 * @param {object|null} viewer - req.user from optionalAuth
 */
export const getCarHoldStatus = async (carKey, viewer = null) => {
  let car = await repo.findCarByKey(carKey);
  if (!car) throw new AppError('Không tìm thấy xe.', 404, DepositErrorCode.CAR_NOT_FOUND);

  if (car.status === CarStatus.RESERVED) {
    await expireDueHoldOfCar(car._id);
    car = await repo.findCarById(car._id);
  }

  const state = toPublicState(car);
  if (state === PublicCarState.UNAVAILABLE) {
    throw new AppError('Không tìm thấy xe.', 404, DepositErrorCode.CAR_NOT_FOUND); // internal statuses are not public
  }

  const now = new Date();
  const hold = state === PublicCarState.RESERVED ? await repo.findActiveHoldByCar(car._id) : null;
  const heldOnline = Boolean(hold && isHeldBy(car, hold));
  const isMine = Boolean(heldOnline && viewer && String(hold.userId) === String(viewer._id));

  return {
    carId: id(car._id),
    vehicleCode: car.vehicleCode,
    state,
    price: car.price,
    serverTime: now,
    hold: state === PublicCarState.RESERVED
      ? {
        source: heldOnline ? 'ONLINE_DEPOSIT' : 'SHOWROOM', // showroom hold = reserved manually, no timer
        reservedAt: heldOnline ? hold.reservedAt : null,
        expiresAt: heldOnline ? hold.expiresAt : null,
        remainingMs: heldOnline ? Math.max(0, new Date(hold.expiresAt).getTime() - now.getTime()) : null,
        isMine,
        deposit: isMine ? toDepositDto(hold, { now }) : null,
      }
      : null,
    policy: state === PublicCarState.AVAILABLE ? computeDepositPolicy(car.price) : null,
    car: toPublicCarDto(car),
  };
};

export const getDepositById = async ({ user, depositId }) => {
  let deposit = await repo.findDepositById(depositId);
  const staff = isStaff(user);
  if (!deposit || (!staff && String(deposit.userId) !== String(user._id))) throw notFound();

  if (deposit.holdActive && new Date(deposit.expiresAt) <= new Date()) {
    try {
      deposit = (await expireDeposit(deposit._id)) || (await repo.findDepositById(depositId)) || deposit;
    } catch (error) {
      logger.error(`[deposit] lazy expiry of ${deposit.depositCode} failed: ${error.message}`);
    }
  }
  let customer = null;
  if (staff) [customer] = await repo.findCustomersByIds([deposit.customerId]);
  return toDepositDto(deposit, { forStaff: staff, customer });
};

/** Customer history ("my deposits"). */
export const listMyDeposits = async ({ user, query }) => {
  const { page, limit, skip } = parsePagination(query, 50);
  const filter = { userId: user._id };
  if (query.status) filter.status = query.status;
  if (query.paymentStatus) filter.paymentStatus = query.paymentStatus;
  const { items, total } = await repo.listDeposits({ filter, skip, limit });
  const now = new Date();
  return { items: items.map((d) => toDepositDto(d, { now })), pagination: buildPaginationMeta(total, page, limit) };
};

/** Staff list with optional filters (also "deposit history of one car" via carId). */
export const listDepositsForStaff = async ({ query }) => {
  const { page, limit, skip } = parsePagination(query, 100);
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.paymentStatus) filter.paymentStatus = query.paymentStatus;
  if (query.carId) filter.carId = query.carId;
  if (query.userId) filter.userId = query.userId;
  if (query.activeOnly) filter.holdActive = true;
  if (query.reviewRequired) filter.reviewRequired = true;
  if (query.depositCode) filter.depositCode = String(query.depositCode).toUpperCase();
  const { items, total } = await repo.listDeposits({ filter, skip, limit });

  const customers = await repo.findCustomersByIds([...new Set(items.map((d) => String(d.customerId)))]);
  const byId = new Map(customers.map((c) => [String(c._id), c]));
  const now = new Date();
  return {
    items: items.map((d) => toDepositDto(d, { forStaff: true, customer: byId.get(String(d.customerId)), now })),
    pagination: buildPaginationMeta(total, page, limit),
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// RECONCILIATION (used by the job)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * a) Finishes car releases interrupted after a deposit was closed (no-transaction mode).
 * b) Closes active holds whose car is no longer RESERVED by them – the car status was
 *    changed outside this flow (e.g. sold via the sales checkout, released manually) or a
 *    create request stopped before reserving the car. Only holds older than the grace
 *    period are checked so in-flight requests are not touched. The car is never modified here.
 */
export const reconcileHolds = async () => {
  const { jobBatchSize: limit, reconcileGraceMs } = getDepositSettings();
  let closed = 0;

  for (const d of await repo.findPendingReleases(limit)) {
    const released = await repo.releaseCarIfHeldBy({ carId: d.carId, stamp: d.carStatusChangedAt });
    await repo.markCarReleased(d._id, released);
  }

  const cutoff = new Date(Date.now() - reconcileGraceMs);
  for (const d of await repo.findActiveHoldsOlderThan(cutoff, limit)) {
    const car = await repo.findCarById(d.carId);
    if (isHeldBy(car, d)) continue;

    const now = new Date();
    const carStatus = car?.status ?? 'MISSING';
    let set;
    if (carStatus === CarStatus.SOLD && d.status === DepositStatus.DEPOSIT_PAID) {
      // Normal case: the sale was closed through the sales checkout, which deducts the deposit.
      set = {
        status: DepositStatus.COMPLETED,
        paymentStatus: DepositPaymentStatus.FULLY_PAID,
        completedAt: now,
        reviewRequired: true,
        reviewNote: 'Xe đã chuyển SOLD qua quy trình chốt đơn – nhân viên đối soát với hợp đồng/Sale Record.',
      };
    } else {
      set = {
        status: DepositStatus.CANCELLED,
        paymentStatus: paymentStatusOnClose(d),
        cancelledAt: now,
        cancelReason: `Trạng thái xe đã thay đổi ngoài luồng đặt cọc (${carStatus}).`,
        reviewRequired: d.paymentStatus !== DepositPaymentStatus.UNPAID,
        reviewNote: d.paymentStatus !== DepositPaymentStatus.UNPAID ? 'Khách đã thanh toán cọc – cần xử lý hoàn cọc.' : null,
      };
    }

    const updated = await repo.transitionDeposit({
      id: d._id,
      fromStatuses: [d.status],
      extraFilter: { holdActive: true, paymentStatus: d.paymentStatus },
      set: { ...set, holdActive: false, carReleasedOnClose: false },
      historyEntry: historyEntry(DepositAction.HOLD_RELEASED, null, `Car status ${carStatus}`),
      session: null,
    });
    if (updated) {
      closed += 1;
      await repo.writeAuditSafe(auditEntry({
        action: DepositAction.HOLD_RELEASED,
        actor: null,
        deposit: updated,
        summary: `Deposit ${updated.depositCode} closed as ${updated.status} – car status is ${carStatus}`,
        extra: { carStatus },
      }));
    }
  }
  return { closed };
};

// ═══════════════════════════════════════════════════════════════════════════
// KAN-99 — VNPay payment intent
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a VNPay sandbox payment URL for an existing PENDING_PAYMENT deposit.
 *
 * Side effects (one DB write): the generated `vnpTxnRef` is persisted on the
 * Deposit so `vnpayIpnService` can match the webhook back to the row. The
 * stamp is unique sparse — regenerating the URL writes a fresh ref, which is
 * fine because only the LATEST txnRef is accepted by the IPN handler.
 *
 * @param {object} args
 * @param {object} args.user       JWT user (from verifyToken)
 * @param {string} args.depositId  ObjectId string
 * @param {string} args.ipAddress  req.ip
 * @returns {Promise<{
 *   depositId: string,
 *   depositCode: string,
 *   paymentProvider: string,
 *   vnpTxnRef: string,
 *   paymentUrl: string,
 *   amount: number,
 *   currency: string,
 *   expiresAt: Date,
 * }>}
 */
export const createVnpayPaymentIntent = async ({ user, depositId, ipAddress }) => {
  const config = assertVnpayEnabled();

  const deposit = await repo.findDepositById(depositId);
  if (!deposit) throw notFound();

  const owner = String(deposit.userId) === String(user?._id);
  if (!owner && !isStaff(user)) {
    throw new AppError('Bạn không có quyền truy cập lượt đặt cọc này.', 403, DepositErrorCode.USER_MISMATCH);
  }

  if (deposit.status !== DepositStatus.PENDING_PAYMENT) {
    throw new AppError('Lượt đặt cọc không còn ở trạng thái chờ thanh toán.', 409, DepositErrorCode.INVALID_STATE);
  }
  if (deposit.paymentStatus !== DepositPaymentStatus.UNPAID) {
    throw new AppError('Tiền cọc đã được ghi nhận trước đó.', 409, DepositErrorCode.VNPAY_ALREADY_PAID);
  }
  if (new Date(deposit.expiresAt).getTime() <= Date.now()) {
    throw new AppError('Lượt đặt cọc đã hết hạn.', 410, DepositErrorCode.EXPIRED);
  }

  // The route's Joi schema accepts MANUAL as default, but once the customer
  // opts into VNPay we flip the provider to make the audit trail match reality.
  // A deposit that went MANUAL cannot roll back to MANUAL after this call —
  // that's fine, we don't support mixed providers inside one deposit anyway.
  const now = new Date();
  let built;
  try {
    built = buildPaymentUrl({
      deposit,
      ipAddress,
      now,
      config,
    });
  } catch (error) {
    logger.error('[vnpay-url] build failed', { depositId: String(deposit._id), error: error?.message });
    throw new AppError('Không tạo được liên kết thanh toán VNPay.', 500, 'VNPAY_URL_BUILD_FAILED');
  }

  // Unique sparse index on vnpayTxnRef is the hard guard — the random ms
  // suffix makes collisions essentially impossible. We retry once in the
  // astronomical case of a collision.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const updated = await Deposit.findOneAndUpdate(
        {
          _id: deposit._id,
          status: DepositStatus.PENDING_PAYMENT,
          paymentStatus: DepositPaymentStatus.UNPAID,
        },
        {
          $set: {
            paymentProvider: PaymentProvider.VNPAY,
            vnpayTxnRef: built.vnpTxnRef,
          },
          $push: {
            history: historyEntry(
              DepositAction.VNPAY_URL_ISSUED,
              user?._id ?? null,
              `TxnRef ${built.vnpTxnRef} • expires ${built.expiresAt.toISOString()}`,
            ),
          },
        },
        { new: true },
      );
      if (!updated) {
        throw new AppError('Lượt đặt cọc đã thay đổi trạng thái. Vui lòng tải lại trang.', 409, DepositErrorCode.INVALID_STATE);
      }
      return {
        depositId: String(updated._id),
        depositCode: updated.depositCode,
        paymentProvider: PaymentProvider.VNPAY,
        vnpTxnRef: built.vnpTxnRef,
        paymentUrl: built.paymentUrl,
        amount: updated.depositAmount,
        currency: updated.currency || 'VND',
        expiresAt: built.expiresAt,
      };
    } catch (error) {
      if (isDuplicateKey(error, 'vnpayTxnRef') && attempt < 2) {
        // Rebuild with a different ms stamp and retry.
        built = buildPaymentUrl({
          deposit,
          ipAddress,
          now: new Date(Date.now() + attempt),
          config,
        });
        continue;
      }
      throw error;
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new AppError('Không tạo được liên kết thanh toán VNPay.', 500, 'VNPAY_URL_BUILD_FAILED');
};

export default {
  createDeposit, expireDeposit, expireDueHoldOfCar, cancelDeposit, confirmDepositPayment, completeDeposit,
  refundDeposit, getCarHoldStatus, getDepositById, listMyDeposits, listDepositsForStaff, reconcileHolds,
  createVnpayPaymentIntent,
  toDepositDto, isStaff,
};
