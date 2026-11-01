// src/services/inventoryService.js
/**
 * Inventory Aging Engine & Markdown Execution Service
 * -------------------------------------------------
 * Provides business logic for:
 *   • Calculating inventory aging (days in stock)
 *   • Determining aging status (FRESH, AGING, CRITICAL)
 *   • Executing automatic markdowns based on aging thresholds
 */

import mongoose from 'mongoose';
import dayjs from 'dayjs';
import Car from '../models/Car.js';
import PriceHistory from '../models/PriceHistory.js';

// Aging thresholds (in days)
export const AGING_THRESHOLDS = {
  FRESH: 30,    // < 30 days: FRESH
  AGING: 60,    // 30 - 60 days: AGING
  CRITICAL: 60, // > 60 days: CRITICAL
};

/**
 * Compute aging information for a single car document.
 * Priority: car.listedDate -> fallback to car.createdAt
 * Returns an object with `ageDays`, `daysInStock`, and `agingStatus`.
 *
 * @param {object} car
 * @returns {{ ageDays: number, daysInStock: number, agingStatus: 'FRESH' | 'AGING' | 'CRITICAL' }}
 */
export const computeAging = (car) => {
  const startDate = car.listedDate || car.createdAt;
  const ageDays = startDate ? Math.max(0, dayjs().diff(dayjs(startDate), 'day')) : 0;

  let agingStatus = 'FRESH';
  if (ageDays > AGING_THRESHOLDS.AGING) {
    agingStatus = 'CRITICAL';
  } else if (ageDays >= AGING_THRESHOLDS.FRESH) {
    agingStatus = 'AGING';
  }

  return {
    ageDays,
    daysInStock: ageDays,
    agingStatus,
  };
};

/**
 * Retrieve cars with aging calculations.
 * Supports optional status filter (e.g., ?status=AVAILABLE).
 *
 * @param {object} filter
 * @returns {Promise<Array>}
 */
export const listAgingCars = async (filter = {}) => {
  const query = {};
  if (filter.status) query.status = filter.status;
  const cars = await Car.find(query).lean();

  // Attach aging info to each car
  const enriched = cars.map((c) => {
    const { ageDays, daysInStock, agingStatus } = computeAging(c);
    return {
      ...c,
      ageDays,
      daysInStock,
      agingStatus,
    };
  });

  return enriched;
};

/**
 * Apply markdown to a car based on its aging status.
 * Returns markdown summary if applied, or null if car is FRESH or ineligible.
 *
 * @param {object} car
 * @param {mongoose.ClientSession} session
 * @param {string|mongoose.Types.ObjectId} [userId] - Authenticated user who triggered markdown
 * @returns {Promise<object|null>}
 */
export const applyMarkdown = async (car, session, userId = null) => {
  const { ageDays, agingStatus } = computeAging(car);

  let discountPct = 0;
  if (agingStatus === 'AGING' || agingStatus === 'SLOW') {
    discountPct = 5;
  } else if (agingStatus === 'CRITICAL' || agingStatus === 'STAGNANT') {
    discountPct = 10;
  }

  if (discountPct === 0) return null; // FRESH cars are not eligible for markdown

  const currentPrice = car.price || car.listedPrice || 0;
  if (currentPrice <= 0) return null;

  let newPrice = Number((currentPrice * (1 - discountPct / 100)).toFixed(2));

  // Safeguard: Never drop price below floorPrice if floorPrice is set
  if (car.floorPrice && car.floorPrice > 0 && newPrice < car.floorPrice) {
    newPrice = car.floorPrice;
  }

  const dropAmount = currentPrice - newPrice;
  if (dropAmount <= 0) return null; // Already at or below floorPrice

  // Determine agingCategory for model schema compatibility
  const agingCategory = agingStatus === 'CRITICAL' ? 'STAGNANT' : 'SLOW';

  // Update car price, daysInStock, and aging category within transaction
  await Car.updateOne(
    { _id: car._id },
    {
      $set: {
        price: newPrice,
        listedPrice: newPrice,
        daysInStock: ageDays,
        agingCategory,
      },
      $inc: { priceDropCount: 1 },
      $push: {
        priceHistory: {
          price: newPrice,
          changedBy: userId,
          changedAt: new Date(),
          reason: `AUTO_MARKDOWN_${agingStatus}`,
        },
      },
    },
    { session }
  );

  // Record price history entry
  const priceHistory = new PriceHistory({
    carId: car._id,
    changedBy: userId,
    oldPrice: currentPrice,
    newPrice,
    dropAmount,
    reason: `AUTO_MARKDOWN_${agingStatus}`,
    notifiedLeadsCount: 0,
  });
  await priceHistory.save({ session });

  return {
    carId: car._id,
    oldPrice: currentPrice,
    newPrice,
    dropAmount,
    discountPct,
    ageDays,
    agingStatus,
  };
};

/**
 * Execute markdown for all eligible cars or a supplied list of IDs.
 * Filters for cars in AGING or CRITICAL status.
 * Wrapped in a MongoDB transaction to guarantee atomicity.
 *
 * @param {Array<string>|null} [carIds=null]
 * @param {string|mongoose.Types.ObjectId|null} [userId=null]
 * @returns {Promise<Array>}
 */
export const executeMarkdown = async (carIds = null, userId = null) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const baseQuery = { price: { $gt: 0 } };
    if (carIds && carIds.length > 0) {
      baseQuery._id = { $in: carIds };
    }

    const cars = await Car.find(baseQuery).session(session);
    const results = [];

    for (const car of cars) {
      const md = await applyMarkdown(car, session, userId);
      if (md) {
        results.push(md);
      }
    }

    await session.commitTransaction();
    session.endSession();
    return results;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

export default {
  AGING_THRESHOLDS,
  computeAging,
  listAgingCars,
  applyMarkdown,
  executeMarkdown,
};
