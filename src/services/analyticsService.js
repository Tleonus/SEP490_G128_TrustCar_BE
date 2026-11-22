/**
 * @file analyticsService.js
 * @description KAN-100 — Admin analytics overview.
 *
 * `getOverview({ from, to })` runs five aggregates in parallel and returns one
 * bundle: {salesByMonth, leadsFunnel, topCars, avgDaysInStock, revenueByStaff}.
 *
 * Caching: results are memoised for 60 s keyed on `from|to` (ISO strings). The
 * cache is bypassed when `NODE_ENV === 'test'` so test suites do not inherit
 * state from each other.
 *
 * All aggregates use native Mongoose `Model.aggregate` so the service has no
 * dependency on repository classes (same pattern as leadScoringService).
 */

import SaleRecord from '../models/sale-record.model.js';
import Lead from '../models/Lead.js';
import Appointment from '../models/Appointment.js';
import Car from '../models/Car.js';
import VisitorSession from '../models/visitor-session.model.js';
import { SaleStatus } from '../models/extendedEnums.js';

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // key → { data, expiresAt }

/** Round to N decimals without accumulating float cruft. */
const round = (value, decimals = 1) => {
  if (value == null || Number.isNaN(value)) return null;
  const p = 10 ** decimals;
  return Math.round(value * p) / p;
};

/** % of (a / b), rounded to 1 decimal. Returns 0 when the denominator is 0. */
const pct = (a, b) => (b > 0 ? round((a / b) * 100, 1) : 0);

// ────────────────────────────────────────────────────────────────────────────
// (a) salesByMonth — always 6 slots ending at `to`, padding the gaps with 0.
// ────────────────────────────────────────────────────────────────────────────
const monthKey = (date) => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
};

const buildEmptySixMonths = (to) => {
  const anchor = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  const slots = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - i, 1));
    slots.push({ month: monthKey(d), count: 0, revenue: 0 });
  }
  return slots;
};

const aggSalesByMonth = async (from, to) => {
  const slots = buildEmptySixMonths(to);
  const earliestSlot = new Date(`${slots[0].month}-01T00:00:00.000Z`);
  // Query range is max(from, 6-month window start) → to.
  const rangeStart = from > earliestSlot ? from : earliestSlot;

  const rows = await SaleRecord.aggregate([
    { $match: {
        status: SaleStatus.COMPLETED,
        saleDate: { $gte: rangeStart, $lte: to },
    } },
    { $group: {
        _id: { y: { $year: '$saleDate' }, m: { $month: '$saleDate' } },
        count:   { $sum: 1 },
        revenue: { $sum: '$finalPrice' },
    } },
  ]);

  const byKey = new Map(rows.map((r) => [
    `${r._id.y}-${String(r._id.m).padStart(2, '0')}`,
    { count: r.count, revenue: r.revenue },
  ]));

  return slots.map((slot) => ({
    month:   slot.month,
    count:   byKey.get(slot.month)?.count   ?? 0,
    revenue: byKey.get(slot.month)?.revenue ?? 0,
  }));
};

// ────────────────────────────────────────────────────────────────────────────
// (b) leadsFunnel — 4 stages with conversion rates between consecutive stages.
// ────────────────────────────────────────────────────────────────────────────
const aggLeadsFunnel = async (from, to) => {
  const range = { $gte: from, $lte: to };
  const [visitors, leads, appointments, sales] = await Promise.all([
    VisitorSession.countDocuments({ startedAt: range }),
    Lead.countDocuments({ createdAt: range }),
    Appointment.countDocuments({ createdAt: range }),
    SaleRecord.countDocuments({ status: SaleStatus.COMPLETED, saleDate: range }),
  ]);

  return {
    visitors,
    leads,
    appointments,
    sales,
    conversionRates: {
      leadRate: pct(leads, visitors),
      apptRate: pct(appointments, leads),
      saleRate: pct(sales, appointments),
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// (c) topCars — 5 best-selling cars in the window.
// ────────────────────────────────────────────────────────────────────────────
const aggTopCars = async (from, to, limit = 5) => {
  const rows = await SaleRecord.aggregate([
    { $match: {
        status: SaleStatus.COMPLETED,
        saleDate: { $gte: from, $lte: to },
    } },
    { $group: {
        _id:     '$carId',
        count:   { $sum: 1 },
        revenue: { $sum: '$finalPrice' },
    } },
    { $sort: { count: -1, revenue: -1 } },
    { $limit: limit },
    { $lookup: {
        from: 'cars', localField: '_id', foreignField: '_id', as: 'car',
    } },
    { $unwind: { path: '$car', preserveNullAndEmptyArrays: true } },
    { $project: {
        _id: 0,
        carId:       '$_id',
        count:       1,
        revenue:     1,
        make:        '$car.make',
        model:       '$car.model',
        year:        '$car.year',
        vehicleCode: '$car.vehicleCode',
    } },
  ]);

  return rows.map((r) => ({
    carId:       r.carId,
    title:       [r.make, r.model, r.year].filter(Boolean).join(' ') || 'Xe không rõ',
    vehicleCode: r.vehicleCode || null,
    count:       r.count,
    revenue:     r.revenue,
  }));
};

// ────────────────────────────────────────────────────────────────────────────
// (d) avgDaysInStock — average days between listedDate and soldAt for cars
//     that completed a sale in the window.
// ────────────────────────────────────────────────────────────────────────────
const aggAvgDaysInStock = async (from, to) => {
  const rows = await SaleRecord.aggregate([
    { $match: {
        status: SaleStatus.COMPLETED,
        saleDate: { $gte: from, $lte: to },
    } },
    { $lookup: {
        from: 'cars', localField: 'carId', foreignField: '_id', as: 'car',
    } },
    { $unwind: '$car' },
    { $match: { 'car.listedDate': { $ne: null } } },
    { $group: {
        _id: null,
        avgDays: {
          $avg: {
            $divide: [
              { $subtract: ['$saleDate', '$car.listedDate'] },
              1000 * 60 * 60 * 24,
            ],
          },
        },
        samples: { $sum: 1 },
    } },
  ]);

  const row = rows[0];
  if (!row || !row.samples) return null;
  return round(row.avgDays, 1);
};

// ────────────────────────────────────────────────────────────────────────────
// (e) revenueByStaff — top 10 sales reps by revenue in the window.
// ────────────────────────────────────────────────────────────────────────────
const aggRevenueByStaff = async (from, to) => {
  const rows = await SaleRecord.aggregate([
    { $match: {
        status: SaleStatus.COMPLETED,
        saleDate: { $gte: from, $lte: to },
    } },
    { $group: {
        _id:     '$recordedByUserId',
        deals:   { $sum: 1 },
        revenue: { $sum: '$finalPrice' },
    } },
    { $sort: { revenue: -1 } },
    { $limit: 10 },
    { $lookup: {
        from: 'users', localField: '_id', foreignField: '_id', as: 'user',
    } },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    { $project: {
        _id: 0,
        userId:   '$_id',
        deals:    1,
        revenue:  1,
        fullName: '$user.fullName',
        email:    '$user.email',
    } },
  ]);

  return rows;
};

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

const cacheKey = (from, to) => `${from.toISOString()}|${to.toISOString()}`;

/** Test-only — wipes the cache so one test cannot taint the next. */
export const __clearAnalyticsCacheForTests = () => cache.clear();

/**
 * Loads the analytics overview.
 * @param {{from: Date, to: Date}} range
 * @returns {Promise<object>} the full overview shape (see SPEC §3.5).
 */
export const getOverview = async ({ from, to }) => {
  const key = cacheKey(from, to);
  const isTest = process.env.NODE_ENV === 'test';
  if (!isTest) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.data;
  }

  const [salesByMonth, leadsFunnel, topCars, avgDaysInStock, revenueByStaff] =
    await Promise.all([
      aggSalesByMonth(from, to),
      aggLeadsFunnel(from, to),
      aggTopCars(from, to, 5),
      aggAvgDaysInStock(from, to),
      aggRevenueByStaff(from, to),
    ]);

  const data = {
    range: { from, to },
    salesByMonth,
    leadsFunnel,
    topCars,
    avgDaysInStock,
    revenueByStaff,
  };

  if (!isTest) {
    cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return data;
};

export default { getOverview, __clearAnalyticsCacheForTests };
