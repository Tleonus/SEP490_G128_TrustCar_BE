// src/services/pricingService.js
import mongoose from 'mongoose';
import Car from '../models/Car.js';
import PriceHistory from '../models/PriceHistory.js';
import { AppError } from '../utils/apiResponse.js';

export const calculateAging = (listedDate) => {
  if (!listedDate) return { daysInStock: 0, agingCategory: 'FRESH' };
  const now = new Date();
  const diff = now - listedDate;
  const daysInStock = Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
  let agingCategory = 'FRESH';
  if (daysInStock > 60) agingCategory = 'STAGNANT';
  else if (daysInStock > 30) agingCategory = 'SLOW';
  return { daysInStock, agingCategory };
};

export const updateInventoryAgingJob = async () => {
  const cars = await Car.find({ status: 'Available' }, 'listedDate daysInStock agingCategory');
  const bulkOps = [];
  let updatedCount = 0;
  for (const car of cars) {
    const { daysInStock, agingCategory } = calculateAging(car.listedDate);
    if (car.daysInStock !== daysInStock || car.agingCategory !== agingCategory) {
      bulkOps.push({ updateOne: { filter: { _id: car._id }, update: { $set: { daysInStock, agingCategory } } } });
      updatedCount++;
    }
  }
  if (bulkOps.length) await Car.bulkWrite(bulkOps);
  return { totalChecked: cars.length, updatedCount };
};

export const executePriceMarkdown = async ({ carId, newPrice, reason, modifiedBy }) => {
  if (!mongoose.Types.ObjectId.isValid(carId)) throw new AppError('Invalid carId', 400);
  if (!mongoose.Types.ObjectId.isValid(modifiedBy)) throw new AppError('Invalid user id', 400);
  if (typeof newPrice !== 'number' || newPrice <= 0) throw new AppError('newPrice must be positive', 400);

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const car = await Car.findById(carId).session(session);
    if (!car) throw new AppError('Car not found', 404);
    if (car.status !== 'Available') throw new AppError('Car not available for markdown', 400);
    if (newPrice >= car.listedPrice) throw new AppError('newPrice must be lower than current listedPrice', 400);
    if (newPrice < car.floorPrice) throw new AppError(`newPrice cannot be lower than floorPrice (${car.floorPrice})`, 422);

    const oldPrice = car.listedPrice;
    const dropAmount = oldPrice - newPrice;
    car.listedPrice = newPrice;
    car.priceDropCount = (car.priceDropCount || 0) + 1;
    await car.save({ session });

    const ph = new PriceHistory({ carId, changedBy: modifiedBy, oldPrice, newPrice, dropAmount, reason });
    await ph.save({ session });

    await session.commitTransaction();
    session.endSession();
    return { car, priceHistory: ph };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

export const getPriceHistoryByCar = async (carId) => {
  if (!mongoose.Types.ObjectId.isValid(carId)) throw new AppError('Invalid carId', 400);
  return await PriceHistory.find({ carId })
    .sort({ createdAt: -1 })
    .populate({ path: 'changedBy', select: 'fullName email role' })
    .lean();
};
