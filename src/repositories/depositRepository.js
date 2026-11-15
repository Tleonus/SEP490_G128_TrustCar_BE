/**
 * @file depositRepository.js
 * @description KAN-22 – encapsulates every MongoDB query of the deposit module
 * (Deposit collection + the few conditional Car updates the hold flow needs).
 *
 * Car writes here never touch carService.js: they are conditional atomic updates that
 * follow the existing state machine (AVAILABLE → RESERVED → AVAILABLE | SOLD) and only
 * apply while the car is still held by the given deposit (same statusChangedAt stamp).
 */

import Deposit from '../models/Deposit.js';
import Car from '../models/Car.js';
import Customer from '../models/Customer.js';
import ActivityLog from '../models/ActivityLog.js';
import { CarStatus } from '../constants/appConstants.js';
import { DepositStatus, ACTIVE_HOLD_STATUSES } from '../constants/depositConstants.js';

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const opts = (session) => (session ? { session } : {});

/** Fields of a car that are safe to show publicly (allowlist). */
export const PUBLIC_CAR_FIELDS = [
  '_id', 'vehicleCode', 'make', 'model', 'variant', 'year', 'bodyType', 'fuelType', 'transmission',
  'driveType', 'mileage', 'specifications', 'price', 'status', 'images', 'description',
  'conditionGrade', 'cpoCertificateId', 'listedDate', 'isActive', 'statusChangedAt',
].join(' ');

// ── Car ───────────────────────────────────────────────────────────────────

export const carKeyFilter = (carKey) => (OBJECT_ID.test(carKey) ? { _id: carKey } : { vehicleCode: String(carKey) });

export const findCarByKey = (carKey, session = null) =>
  Car.findOne(carKeyFilter(carKey), PUBLIC_CAR_FIELDS, opts(session)).lean();

export const findCarById = (carId, session = null) =>
  Car.findById(carId, PUBLIC_CAR_FIELDS, opts(session)).lean();

/** AVAILABLE → RESERVED, only if still AVAILABLE, active and at the expected price. */
export const reserveCarIfAvailable = async ({ carId, expectedPrice, userId, stamp, session }) => {
  const result = await Car.updateOne(
    { _id: carId, isActive: true, status: CarStatus.AVAILABLE, price: expectedPrice },
    { $set: { status: CarStatus.RESERVED, statusChangedAt: stamp, statusChangedBy: userId, updatedBy: userId } },
    opts(session),
  );
  return result.modifiedCount === 1;
};

/** RESERVED → AVAILABLE, only while still held by this deposit (same stamp). Never touches SOLD. */
export const releaseCarIfHeldBy = async ({ carId, stamp, actorId = null, now = new Date(), session }) => {
  const result = await Car.updateOne(
    { _id: carId, status: CarStatus.RESERVED, statusChangedAt: stamp },
    { $set: { status: CarStatus.AVAILABLE, statusChangedAt: now, statusChangedBy: actorId } },
    opts(session),
  );
  return result.modifiedCount === 1;
};

/** RESERVED → SOLD (full payment), only while still held by this deposit (same stamp). */
export const sellCarIfHeldBy = async ({ carId, stamp, actorId, now = new Date(), session }) => {
  const result = await Car.updateOne(
    { _id: carId, status: CarStatus.RESERVED, statusChangedAt: stamp },
    { $set: { status: CarStatus.SOLD, soldAt: now, statusChangedAt: now, statusChangedBy: actorId, updatedBy: actorId } },
    opts(session),
  );
  return result.modifiedCount === 1;
};

// ── Customer ──────────────────────────────────────────────────────────────

export const findActiveCustomer = (customerId, session = null) =>
  Customer.findOne({ _id: customerId, isActive: true }, '_id', opts(session)).lean();

/** Writes the customer document so two simultaneous deposits of one customer conflict (transactions only). */
export const touchCustomer = (customerId, session) =>
  Customer.updateOne({ _id: customerId }, { $set: { updatedAt: new Date() } }, opts(session));

export const findCustomersByIds = (ids) =>
  Customer.find({ _id: { $in: ids } }, 'fullName phone email').lean();

// ── Deposit ───────────────────────────────────────────────────────────────

export const createDeposit = async (doc, session = null) => {
  const [created] = await Deposit.create([doc], opts(session));
  return created.toObject();
};

/** Compensation only (no-transaction mode): removes a deposit whose car could not be reserved. */
export const deleteUnreservedDeposit = (id) =>
  Deposit.deleteOne({ _id: id, status: DepositStatus.PENDING_PAYMENT, paidAt: null });

export const findDepositById = (id, session = null) => Deposit.findById(id, null, opts(session)).lean();

export const findActiveHoldByCar = (carId, session = null) =>
  Deposit.findOne({ carId, holdActive: true }, null, opts(session)).lean();

export const countActiveHoldsByCustomer = (customerId, session = null) =>
  Deposit.countDocuments({ customerId, holdActive: true }, opts(session));

/**
 * Atomically moves a deposit from one of `fromStatuses` to a new state.
 * The deposit document is the serialisation point between expiry, cancel, confirm and complete.
 * @returns {Promise<object|null>} the updated deposit, or null if it was no longer in that state.
 */
export const transitionDeposit = ({ id, fromStatuses, extraFilter = {}, set, historyEntry, session }) =>
  Deposit.findOneAndUpdate(
    { _id: id, status: { $in: fromStatuses }, ...extraFilter },
    { $set: set, $push: { history: historyEntry } },
    { new: true, runValidators: true, ...opts(session) },
  ).lean();

/** Undo of a transition (no-transaction compensation): only if the deposit is still in `expectFilter` state. */
export const revertDeposit = ({ id, expectFilter, set, historyEntry }) =>
  Deposit.findOneAndUpdate(
    { _id: id, ...expectFilter },
    { $set: set, ...(historyEntry ? { $push: { history: historyEntry } } : {}) },
    { new: true },
  ).lean();

export const markCarReleased = (id, released, session = null) =>
  Deposit.updateOne({ _id: id }, { $set: { carReleasedOnClose: released } }, opts(session));

export const findDueExpirations = (now, limit) =>
  Deposit.find(
    { status: { $in: ACTIVE_HOLD_STATUSES }, holdActive: true, expiresAt: { $lte: now } },
    '_id',
  ).sort({ expiresAt: 1 }).limit(limit).lean();

/** Closed deposits whose car release was never attempted (process stopped mid-way). */
export const findPendingReleases = (limit) =>
  Deposit.find(
    { holdActive: false, status: { $in: [DepositStatus.EXPIRED, DepositStatus.CANCELLED] }, carReleasedOnClose: null },
    '_id carId carStatusChangedAt',
  ).limit(limit).lean();

export const findActiveHoldsOlderThan = (date, limit) =>
  Deposit.find({ holdActive: true, reservedAt: { $lte: date } }).limit(limit).lean();

export const listDeposits = async ({ filter, skip, limit }) => {
  const [items, total] = await Promise.all([
    Deposit.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    Deposit.countDocuments(filter),
  ]);
  return { items, total };
};

// ── Audit ─────────────────────────────────────────────────────────────────

/** Audit entry written inside the same transaction as the change (if any). */
export const writeAudit = (entry, session = null) => ActivityLog.create([entry], { ...opts(session), ordered: true });

/** Best-effort audit (never blocks the caller in development; see ActivityLog.log). */
export const writeAuditSafe = (entry) => ActivityLog.log(entry);

export default {
  PUBLIC_CAR_FIELDS, carKeyFilter, findCarByKey, findCarById, reserveCarIfAvailable, releaseCarIfHeldBy,
  sellCarIfHeldBy, findActiveCustomer, touchCustomer, findCustomersByIds, createDeposit, deleteUnreservedDeposit,
  findDepositById, findActiveHoldByCar, countActiveHoldsByCustomer, transitionDeposit, revertDeposit,
  markCarReleased, findDueExpirations, findPendingReleases, findActiveHoldsOlderThan, listDeposits,
  writeAudit, writeAuditSafe,
};
