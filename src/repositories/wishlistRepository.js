/**
 * @file wishlistRepository.js
 * @description Data-access layer for Saved Cars Wishlist & Price Drop Alerts.
 * Encapsulates all Mongoose queries for SavedCar and related projections on
 * Car, User, and PriceHistory.
 */

import SavedCar from '../models/SavedCar.js';
import Car from '../models/Car.js';
import User from '../models/User.js';
import PriceHistory from '../models/PriceHistory.js';
import { CarStatus, Roles } from '../constants/appConstants.js';

/** Publicly safe scalar fields of Car exposed to wishlist consumers. */
export const WISHLIST_CAR_BASIC_FIELDS = [
  'vehicleCode',
  'make',
  'model',
  'variant',
  'year',
  'bodyType',
  'fuelType',
  'transmission',
  'driveType',
  'mileage',
  'price',
  'ownerType',
  'conditionGrade',
  'cpoCertificateId',
];

/**
 * Allow-list projection for Car documents loaded by the wishlist module.
 * `status` and `isActive` are projected solely to compute `isAvailable` in the
 * service layer and are stripped by the DTO mapper before leaving the backend.
 * `images.publicId`, `vin`, `licensePlate`, `floorPrice`, `priceHistory`, and
 * `internalNotes` are never projected.
 */
export const WISHLIST_CAR_PROJECTION = Object.fromEntries(
  [
    ...WISHLIST_CAR_BASIC_FIELDS,
    'status',
    'isActive',
    'images.url',
    'images.isPrimary',
  ].map((path) => [path, 1])
);

export const findAvailableCarById = async (carId) =>
  Car.findOne(
    { _id: carId, status: CarStatus.AVAILABLE, isActive: true },
    WISHLIST_CAR_PROJECTION
  ).lean();

export const findAvailableCarsByIds = async (carIds) =>
  Car.find(
    { _id: { $in: carIds }, status: CarStatus.AVAILABLE, isActive: true },
    WISHLIST_CAR_PROJECTION
  ).lean();

export const findCarsByIdsForWishlist = async (carIds) => {
  if (!carIds.length) return [];
  return Car.find({ _id: { $in: carIds } }, WISHLIST_CAR_PROJECTION).lean();
};

export const findCarForAlertNotification = async (carId) =>
  Car.findById(carId, WISHLIST_CAR_PROJECTION).lean();

export const countSavedByUser = async (userId) =>
  SavedCar.countDocuments({ user: userId });

export const findSavedByUserAndCar = async (userId, carId) =>
  SavedCar.findOne({ user: userId, car: carId }).lean();

export const findSavedByUserAndCars = async (userId, carIds) => {
  if (!carIds.length) return [];
  return SavedCar.find({ user: userId, car: { $in: carIds } }).lean();
};

export const findAllSavedByUser = async (userId) =>
  SavedCar.find({ user: userId })
    .sort({ createdAt: -1, _id: -1 })
    .lean();

export const findPaginatedSavedByUser = async (userId, { skip, limit }) => {
  const [items, total] = await Promise.all([
    SavedCar.find({ user: userId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SavedCar.countDocuments({ user: userId }),
  ]);
  return { items, total };
};

export const createSavedCar = async ({ userId, carId, priceAtSave, priceAlertEnabled = true }) => {
  const doc = await SavedCar.create({
    user: userId,
    car: carId,
    priceAtSave,
    priceAlertEnabled,
  });
  return doc.toObject();
};

export const updateAlertPreference = async (userId, carId, priceAlertEnabled) =>
  SavedCar.findOneAndUpdate(
    { user: userId, car: carId },
    { $set: { priceAlertEnabled } },
    { new: true, runValidators: true }
  ).lean();

export const deleteSavedCar = async (userId, carId) =>
  SavedCar.findOneAndDelete({ user: userId, car: carId }).lean();

export const markAlertAsRead = async (userId, alertId) => {
  const doc = await SavedCar.findOne({ user: userId, 'priceAlerts._id': alertId });
  if (!doc) return null;

  const alert = doc.priceAlerts.find((entry) => String(entry._id) === String(alertId));
  if (!alert) return null;

  if (!alert.isRead) {
    alert.isRead = true;
    await doc.save();
  }
  return doc.toObject();
};

export const markAllAlertsAsRead = async (userId) => {
  const docs = await SavedCar.find({ user: userId });
  let markedCount = 0;

  for (const doc of docs) {
    let changed = false;
    for (const alert of doc.priceAlerts) {
      if (!alert.isRead) {
        alert.isRead = true;
        markedCount += 1;
        changed = true;
      }
    }
    if (changed) {
      await doc.save();
    }
  }

  return markedCount;
};

export const findAlertSubscribersByCar = async (carId) =>
  SavedCar.find({ car: carId, priceAlertEnabled: true }).lean();

export const findActiveCustomersByIds = async (userIds) => {
  if (!userIds.length) return [];
  return User.find({
    _id: { $in: userIds },
    isActive: true,
    roleName: Roles.CUSTOMER,
  })
    .select('_id fullName email')
    .lean();
};

export const appendPriceAlert = async (savedId, alertEntry) =>
  SavedCar.updateOne(
    { _id: savedId },
    {
      $push: {
        priceAlerts: {
          $each: [alertEntry],
          $slice: -50,
        },
      },
    }
  );

export const updatePriceHistoryNotifiedCount = async (priceHistoryId, count) => {
  if (!priceHistoryId) return;
  await PriceHistory.updateOne(
    { _id: priceHistoryId },
    { $set: { notifiedLeadsCount: count } }
  );
};

export default {
  WISHLIST_CAR_BASIC_FIELDS,
  WISHLIST_CAR_PROJECTION,
  findAvailableCarById,
  findAvailableCarsByIds,
  findCarsByIdsForWishlist,
  findCarForAlertNotification,
  countSavedByUser,
  findSavedByUserAndCar,
  findSavedByUserAndCars,
  findAllSavedByUser,
  findPaginatedSavedByUser,
  createSavedCar,
  updateAlertPreference,
  deleteSavedCar,
  markAlertAsRead,
  markAllAlertsAsRead,
  findAlertSubscribersByCar,
  findActiveCustomersByIds,
  appendPriceAlert,
  updatePriceHistoryNotifiedCount,
};

