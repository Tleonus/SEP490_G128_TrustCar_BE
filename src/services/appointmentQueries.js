/**
 * @file appointmentQueries.js
 * @description Every database READ of the test-drive booking feature. All queries
 * are lean and projected; related documents are loaded with one `$in` query each
 * (never one query per row). Writes live in the booking/customer/staff services.
 *
 * Ref: .sdd/features/test-drive-booking/PLAN.md (C-Q)
 */

import Appointment from '../models/Appointment.js';
import Car from '../models/Car.js';
import Customer from '../models/Customer.js';
import User from '../models/User.js';
import { CarStatus } from '../constants/appConstants.js';
import { OPEN_STATUSES } from '../constants/appointmentRules.js';

const OPEN_FILTER = { status: { $in: OPEN_STATUSES }, isActive: true };
const LIGHT_FIELDS = 'customer car scheduledAt status isActive visitSeat slotSeat';
const CAR_FIELDS = 'vehicleCode make model variant year status isActive images';
const CUSTOMER_FIELDS = 'fullName phone email';
const USER_FIELDS = 'fullName';

/** Plain object whether the input is a Mongoose document or already plain. */
export const plain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);

/** Open rows (any customer) at exactly `scheduledAt`. Inside a transaction pass its `session`. */
export const findOpenAtSlot = (scheduledAt, { session = null } = {}) =>
  Appointment.find({ ...OPEN_FILTER, scheduledAt }).select(LIGHT_FIELDS).session(session).lean();

/** Open future rows of one customer, any slot. Inside a transaction pass its `session`. */
export const findCustomerOpen = (customerId, now, { session = null } = {}) =>
  Appointment.find({ ...OPEN_FILTER, customer: customerId, scheduledAt: { $gt: now } })
    .select(LIGHT_FIELDS).session(session).lean();

/** Open rows of every customer with `from <= scheduledAt < toExclusive` (one query for /slots). */
export const findOpenInRange = (from, toExclusive) =>
  Appointment.find({ ...OPEN_FILTER, scheduledAt: { $gte: from, $lt: toExclusive } })
    .select(LIGHT_FIELDS).lean();

/** Like `findOpenInRange` plus the appointment code (staff slot view shows visit codes). */
export const findOpenInRangeWithCode = (from, toExclusive) =>
  Appointment.find({ ...OPEN_FILTER, scheduledAt: { $gte: from, $lt: toExclusive } })
    .select(`${LIGHT_FIELDS} appointmentCode`).lean();

/** All visible rows of ONE visit `(customer, scheduledAt)`. Inside a transaction pass its `session`. */
export const findVisitRows = (customerId, scheduledAt, { session = null } = {}) =>
  Appointment.find({ customer: customerId, scheduledAt, isActive: true }).session(session).lean();

/** Every open row of one car (used when the car stops being sellable). */
export const findOpenByCar = (carId) => Appointment.find({ ...OPEN_FILTER, car: carId }).lean();

/** All visible rows of one customer, newest visit first. */
export const findCustomerRows = (customerId) =>
  Appointment.find({ customer: customerId, isActive: true }).sort({ scheduledAt: -1 }).lean();

/** All visible rows with `scheduledAt >= from` (and `< toExclusive` when given), for staff. */
export const findRowsInRange = (from, toExclusive = null) => {
  const scheduledAt = toExclusive ? { $gte: from, $lt: toExclusive } : { $gte: from };
  return Appointment.find({ isActive: true, scheduledAt }).sort({ scheduledAt: 1 }).lean();
};

/**
 * All visible rows of the visit that contains appointment `id`.
 * With `customerId`, only a visit owned by that customer is returned (else `[]`).
 */
export const findVisitRowsByAnyId = async (id, { customerId = null } = {}) => {
  const filter = { _id: id, isActive: true };
  if (customerId) filter.customer = customerId;
  const anchor = await Appointment.findOne(filter).lean();
  if (!anchor) return [];
  return Appointment.find({ customer: anchor.customer, scheduledAt: anchor.scheduledAt, isActive: true }).lean();
};

const mapById = (docs) => new Map(docs.map((doc) => [String(doc._id), doc]));
const unique = (values) => [...new Set(values.filter(Boolean).map(String))];

/**
 * Loads the cars of the visits (and, for staff, customers and handling staff)
 * with one query each. Returns Maps keyed by string id.
 */
export const loadVisitContext = async (visits, { staff = false } = {}) => {
  const rows = visits.flatMap((visit) => visit.rows);
  const carIds = unique(rows.map((row) => row.car));
  // An empty id list means nothing to load: skip the query instead of asking for `$in: []`.
  const load = (Model, ids, fields) => (ids.length === 0 ? [] : Model.find({ _id: { $in: ids } }).select(fields).lean());
  const cars = await load(Car, carIds, CAR_FIELDS);
  if (!staff) return { carsById: mapById(cars), customersById: new Map(), usersById: new Map() };

  const customerIds = unique(visits.map((visit) => visit.customer));
  const userIds = unique(rows.flatMap((row) => [row.assignedTo, row.confirmedBy]));
  const [customers, users] = await Promise.all([
    load(Customer, customerIds, CUSTOMER_FIELDS),
    load(User, userIds, USER_FIELDS),
  ]);
  return { carsById: mapById(cars), customersById: mapById(customers), usersById: mapById(users) };
};

/** Bookable cars: exist, AVAILABLE and active. Returns lean docs. */
export const findBookableCars = (carIds) =>
  Car.find({ _id: { $in: carIds }, status: CarStatus.AVAILABLE, isActive: true }).select(CAR_FIELDS).lean();

// ── 1.1.0 ────────────────────────────────────────────────────────────────────

/** Open future rows of every customer (light fields), for reconciliation. */
export const findOpenFuture = (now) =>
  Appointment.find({ ...OPEN_FILTER, scheduledAt: { $gt: now } }).select(LIGHT_FIELDS).lean();

/** Of `carIds`, the cars that are no longer sellable (status not AVAILABLE, or inactive). */
export const findUnsellableCars = (carIds) =>
  Car.find({ _id: { $in: carIds }, $or: [{ status: { $ne: CarStatus.AVAILABLE } }, { isActive: false }] })
    .select('vehicleCode make model variant status isActive').lean();

/**
 * All visible rows of the visits `(customer, scheduledAt)` listed in `pairs`, in one query.
 * (The query narrows by customer and time; callers keep only the exact pairs.)
 */
export const findRowsOfVisits = (pairs) =>
  Appointment.find({
    isActive: true,
    customer: { $in: [...new Set(pairs.map((pair) => String(pair.customer)))] },
    scheduledAt: { $in: pairs.map((pair) => pair.scheduledAt) },
  }).lean();

/** Contact data of a customer for e-mails, or null. */
export const findCustomerContact = (customerId) =>
  Customer.findOne({ _id: customerId }).select('fullName email').lean();

/**
 * Hidden rows left behind by earlier reschedules (reason `RESCHEDULED:<code>`) of the given
 * customers. Filtering by `customer` keeps this on an indexed field (`cancellationReason` is not).
 */
export const findHiddenReschedules = ({ customerIds, reasons }) =>
  Appointment.find({ customer: { $in: customerIds }, isActive: false, cancellationReason: { $in: reasons } })
    .select('customer appointmentCode cancellationReason scheduledAt').lean();

/**
 * The customer when they exist AND have an active CUSTOMER account, else null. Staff may only
 * book for customers who can see and manage their visits (C28).
 */
export const findCustomerWithAccount = async (customerId) => {
  const [customer, account] = await Promise.all([
    Customer.findOne({ _id: customerId }).select(CUSTOMER_FIELDS).lean(),
    User.findOne({ customer: customerId, roleName: 'CUSTOMER', isActive: true }).select('_id').lean(),
  ]);
  return customer && account ? customer : null;
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEARCH_POOL = 50;

/**
 * Customers staff may book for: name / phone / e-mail contains `q` AND the customer has an
 * active CUSTOMER account. At most `limit` results, four fields only (C28).
 */
export const searchCustomers = async (q, limit) => {
  const pattern = escapeRegex(q);
  const like = { $regex: pattern, $options: 'i' };
  const candidates = await Customer.find({ $or: [{ fullName: like }, { phone: like }, { email: like }] })
    .select('fullName phone email').limit(SEARCH_POOL).lean();
  if (candidates.length === 0) return [];
  const accounts = await User.find({
    customer: { $in: candidates.map((customer) => customer._id) }, roleName: 'CUSTOMER', isActive: true,
  }).select('customer').lean();
  const withAccount = new Set(accounts.map((account) => String(account.customer)));
  return candidates.filter((customer) => withAccount.has(String(customer._id))).slice(0, limit);
};
