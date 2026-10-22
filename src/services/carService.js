/**
 * @file carService.js
 * @description Vehicle inventory business logic for the TrustCar platform.
 *
 * Enforces:
 * - GBR-04: VIN uniqueness across non-DELISTED records
 * - GBR-05: Status state machine transitions
 * - GBR-06: Sold vehicle read-only lock
 * - GBR-07: Price history append-only
 * - GBR-08: License plate active-inventory uniqueness
 * - GBR-09: Mileage cannot decrease
 * - GBR-13: Auto-generated vehicleCode (TC-YYYY-NNNN)
 * - GBR-14: Single primary image
 * - GBR-15: Max 20 images per vehicle
 * - GBR-24: Audit logging for all mutations
 * - GBR-25: Soft-delete only
 */

import Car from '../models/Car.js';
import ActivityLog from '../models/ActivityLog.js';
import { uploadToCloudinary, deleteFromCloudinary } from '../config/cloudinary.js';
import { generateVehicleCode } from '../utils/codeGenerator.js';
import { AppError, parsePagination, buildPaginationMeta } from '../utils/apiResponse.js';
import {
  CarStatus,
  CAR_STATUS_TRANSITIONS,
  ActivityEventType,
  UPLOAD,
} from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';

// ════════════════════════════════════════════════════════════════════════════
// ASSERTION HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Asserts that no active vehicle (non-DELISTED) already has this VIN.
 * Excludes the current vehicle when updating (pass currentId to skip self).
 * Ref: GBR-04
 */
const assertVinUnique = async (vin, currentId = null) => {
  const filter = {
    vin:    vin.toUpperCase(),
    status: { $ne: CarStatus.DELISTED },
  };
  if (currentId) filter._id = { $ne: currentId };

  const exists = await Car.exists(filter);
  if (exists) throw new AppError(MSG.MSG20.message, MSG.MSG20.httpStatus, MSG.MSG20.code);
};

/**
 * Asserts that no active-inventory vehicle has this license plate.
 * Active statuses: INCOMING, MAINTENANCE, AVAILABLE, RESERVED.
 * SOLD and DELISTED are excluded (GBR-08).
 */
const assertPlateUnique = async (plate, currentId = null) => {
  const filter = {
    licensePlate: plate.toUpperCase(),
    status:       { $in: [CarStatus.INCOMING, CarStatus.MAINTENANCE, CarStatus.AVAILABLE, CarStatus.RESERVED] },
  };
  if (currentId) filter._id = { $ne: currentId };

  const exists = await Car.exists(filter);
  if (exists) throw new AppError(MSG.MSG25.message, MSG.MSG25.httpStatus, MSG.MSG25.code);
};

/**
 * Asserts the vehicle is not in SOLD state (read-only lock).
 * Ref: GBR-06
 */
const assertNotSold = (car) => {
  if (car.status === CarStatus.SOLD) {
    throw new AppError(MSG.MSG23.message, MSG.MSG23.httpStatus, MSG.MSG23.code);
  }
};

/**
 * Validates that the requested status transition is permitted.
 * Ref: GBR-05
 */
const assertValidTransition = (currentStatus, targetStatus) => {
  const allowed = CAR_STATUS_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(targetStatus)) {
    throw new AppError(
      `${MSG.MSG21.message} (${currentStatus} → ${targetStatus} is not allowed)`,
      MSG.MSG21.httpStatus,
      MSG.MSG21.code
    );
  }
};

// ════════════════════════════════════════════════════════════════════════════
// CAR SERVICE METHODS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Creates a new vehicle record.
 * Generates vehicleCode (TC-YYYY-NNNN), validates VIN and plate uniqueness.
 *
 * @param {object} data    - Validated body from carController.
 * @param {string} userId  - ID of the staff member creating the record.
 * @param {string} [ipAddress]
 * @returns {Promise<object>} Created Car document.
 */
export const createCar = async (data, userId, ipAddress) => {
  // Uniqueness checks (GBR-04, GBR-08)
  await assertVinUnique(data.vin);
  await assertPlateUnique(data.licensePlate);

  // Generate unique vehicle code (GBR-13)
  const vehicleCode = await generateVehicleCode(Car);

  const car = await Car.create({
    ...data,
    vehicleCode,
    vin:          data.vin.toUpperCase(),
    licensePlate: data.licensePlate.toUpperCase(),
    status:       CarStatus.INCOMING,
    priceHistory: [{
      price:     data.price,
      changedBy: userId,
      reason:    'Initial intake price',
    }],
    createdBy: userId,
  });

  await ActivityLog.log({
    eventType:    ActivityEventType.CAR_CREATED,
    performedBy:  userId,
    targetModel:  'Car',
    targetId:     car._id,
    targetCode:   car.vehicleCode,
    summary:      `Vehicle ${car.vehicleCode} (${car.make} ${car.model} ${car.year}) created`,
    ipAddress,
  });

  return car;
};

/**
 * Retrieves a paginated, filtered list of all vehicles (staff view – all statuses).
 *
 * @param {object} query - req.query with optional filters: status, make, model, year, search
 * @returns {Promise<{ items: Array, pagination: object }>}
 */
export const getCars = async (query) => {
  const { page, limit, skip } = parsePagination(query);

  const filter = { isActive: true };
  if (query.status) filter.status = query.status;
  if (query.make)   filter.make   = { $regex: query.make, $options: 'i' };
  if (query.model)  filter.model  = { $regex: query.model, $options: 'i' };
  if (query.year)   filter.year   = Number(query.year);

  if (query.search) {
    filter.$or = [
      { vehicleCode:   { $regex: query.search, $options: 'i' } },
      { vin:           { $regex: query.search, $options: 'i' } },
      { licensePlate:  { $regex: query.search, $options: 'i' } },
      { make:          { $regex: query.search, $options: 'i' } },
      { model:         { $regex: query.search, $options: 'i' } },
    ];
  }

  const sortBy  = query.sortBy  || 'createdAt';
  const sortDir = query.sortDir === 'asc' ? 1 : -1;

  const [items, total] = await Promise.all([
    Car.find(filter)
      .populate('createdBy', 'fullName email')
      .sort({ [sortBy]: sortDir })
      .skip(skip)
      .limit(limit)
      .lean(),
    Car.countDocuments(filter),
  ]);

  return { items, pagination: buildPaginationMeta(total, page, limit) };
};

/**
 * Retrieves a single vehicle by ID (staff view, all statuses).
 * @param {string} carId
 * @returns {Promise<object>} Full Car document.
 */
export const getCarById = async (carId) => {
  const car = await Car.findOne({ _id: carId, isActive: true })
    .populate('createdBy', 'fullName email')
    .populate('updatedBy', 'fullName email')
    .populate('priceHistory.changedBy', 'fullName email');

  if (!car) throw new AppError(MSG.MSG61.message, 404, MSG.MSG61.code);
  return car;
};

/**
 * Updates mutable vehicle fields.
 * Enforces:
 * - GBR-06: Cannot update a SOLD vehicle
 * - GBR-07: Price change appends to priceHistory
 * - GBR-08: Plate uniqueness on change
 * - GBR-09: Mileage cannot decrease
 *
 * @param {object} params
 * @param {string} params.carId
 * @param {object} params.updates   - Validated body fields.
 * @param {string} params.userId
 * @param {string} [params.ipAddress]
 * @returns {Promise<object>} Updated Car document.
 */
export const updateCar = async ({ carId, updates, userId, ipAddress }) => {
  const car = await Car.findOne({ _id: carId, isActive: true });
  if (!car) throw new AppError(MSG.MSG61.message, 404, MSG.MSG61.code);

  // GBR-06: Sold lock
  assertNotSold(car);

  const before = { price: car.price, mileage: car.mileage, licensePlate: car.licensePlate };

  // GBR-04: VIN uniqueness on change
  if (updates.vin && updates.vin.toUpperCase() !== car.vin) {
    await assertVinUnique(updates.vin, carId);
    car.vin = updates.vin.toUpperCase();
  }

  // GBR-08: Plate uniqueness on change
  if (updates.licensePlate && updates.licensePlate.toUpperCase() !== car.licensePlate) {
    await assertPlateUnique(updates.licensePlate, carId);
    car.licensePlate = updates.licensePlate.toUpperCase();
  }

  // GBR-09: Mileage cannot decrease
  if (updates.mileage !== undefined && updates.mileage < car.mileage) {
    throw new AppError(MSG.MSG26.message, MSG.MSG26.httpStatus, MSG.MSG26.code);
  }

  // GBR-07: Price change → append to history
  if (updates.price !== undefined && updates.price !== car.price) {
    car.priceHistory.push({
      price:     updates.price,
      changedBy: userId,
      reason:    updates.priceChangeReason || null,
    });
    car.price = updates.price;
    delete updates.price;

    await ActivityLog.log({
      eventType:   ActivityEventType.CAR_PRICE_UPDATED,
      performedBy: userId,
      targetModel: 'Car',
      targetId:    car._id,
      targetCode:  car.vehicleCode,
      changes:     { before: { price: before.price }, after: { price: car.price } },
      summary:     `Price updated from ${before.price} to ${car.price} VND`,
      ipAddress,
    });
  }

  // Apply remaining field updates
  const allowedFields = [
    'make', 'model', 'variant', 'year', 'bodyType', 'fuelType',
    'transmission', 'driveType', 'mileage', 'description',
    'conditionGrade', 'registrationExpiry', 'specifications',
    'internalNotes', 'carModelRef',
  ];
  allowedFields.forEach((field) => {
    if (updates[field] !== undefined) car[field] = updates[field];
  });

  car.updatedBy = userId;
  await car.save();

  await ActivityLog.log({
    eventType:   ActivityEventType.CAR_UPDATED,
    performedBy: userId,
    targetModel: 'Car',
    targetId:    car._id,
    targetCode:  car.vehicleCode,
    changes:     { before, after: { price: car.price, mileage: car.mileage, licensePlate: car.licensePlate } },
    summary:     `Vehicle ${car.vehicleCode} fields updated`,
    ipAddress,
  });

  return car;
};

/**
 * Transitions a vehicle's status according to the state machine.
 * Ref: GBR-05, GBR-06
 *
 * @param {object} params
 * @param {string} params.carId
 * @param {string} params.targetStatus  - Target CarStatus value.
 * @param {string} params.userId
 * @param {string} [params.reason]
 * @param {string} [params.ipAddress]
 * @returns {Promise<object>} Updated Car document.
 */
export const updateCarStatus = async ({ carId, targetStatus, userId, reason, ipAddress }) => {
  const car = await Car.findOne({ _id: carId, isActive: true });
  if (!car) throw new AppError(MSG.MSG61.message, 404, MSG.MSG61.code);

  const previousStatus = car.status;
  assertValidTransition(previousStatus, targetStatus); // GBR-05

  car.status          = targetStatus;
  car.statusChangedBy = userId;
  car.statusChangedAt = new Date();
  car.updatedBy       = userId;

  if (targetStatus === CarStatus.SOLD) {
    car.soldAt = new Date();
  }

  await car.save();

  await ActivityLog.log({
    eventType:   ActivityEventType.CAR_STATUS_CHANGED,
    performedBy: userId,
    targetModel: 'Car',
    targetId:    car._id,
    targetCode:  car.vehicleCode,
    changes:     { before: { status: previousStatus }, after: { status: targetStatus } },
    summary:     `Status: ${previousStatus} → ${targetStatus}`,
    metadata:    { reason },
    ipAddress,
  });

  return car;
};

/**
 * Uploads images to Cloudinary and appends to the vehicle's images array.
 * Enforces GBR-15 (max 20 images) and GBR-14 (single primary).
 *
 * @param {object} params
 * @param {string} params.carId
 * @param {Array}  params.files      - Multer file objects with .buffer.
 * @param {boolean} [params.setFirstAsPrimary=false]
 * @param {string} params.userId
 * @param {string} [params.ipAddress]
 * @returns {Promise<object>} Updated Car document.
 */
export const uploadCarImages = async ({ carId, files, setFirstAsPrimary, userId, ipAddress }) => {
  const car = await Car.findOne({ _id: carId, isActive: true });
  if (!car) throw new AppError(MSG.MSG61.message, 404, MSG.MSG61.code);

  assertNotSold(car); // GBR-06

  // GBR-15: Max 20 images
  if (car.images.length + files.length > UPLOAD.MAX_IMAGES_PER_CAR) {
    throw new AppError(MSG.MSG29.message, MSG.MSG29.httpStatus, MSG.MSG29.code);
  }

  const uploaded = await Promise.all(
    files.map((file) =>
      uploadToCloudinary(file.buffer, `trustcar/vehicles/${car.vehicleCode}`)
    )
  );

  const hasExistingPrimary = car.images.some((img) => img.isPrimary);

  uploaded.forEach((result, idx) => {
    const isPrimary = setFirstAsPrimary && idx === 0 && !hasExistingPrimary;
    if (isPrimary) {
      // GBR-14: Demote any existing primary
      car.images.forEach((img) => { img.isPrimary = false; });
    }
    car.images.push({
      url:       result.url,
      publicId:  result.publicId,
      isPrimary: setFirstAsPrimary && idx === 0 && !hasExistingPrimary,
    });
  });

  car.updatedBy = userId;
  await car.save();

  await ActivityLog.log({
    eventType:   ActivityEventType.CAR_IMAGE_ADDED,
    performedBy: userId,
    targetModel: 'Car',
    targetId:    car._id,
    targetCode:  car.vehicleCode,
    summary:     `${uploaded.length} image(s) uploaded to ${car.vehicleCode}`,
    ipAddress,
  });

  return car;
};

/**
 * Removes a specific image from a vehicle by its Cloudinary publicId.
 * Ref: GBR-14, GBR-15
 *
 * @param {object} params
 * @param {string} params.carId
 * @param {string} params.imageId   - The _id of the image subdocument.
 * @param {string} params.userId
 * @param {string} [params.ipAddress]
 * @returns {Promise<object>} Updated Car document.
 */
export const deleteCarImage = async ({ carId, imageId, userId, ipAddress }) => {
  const car = await Car.findOne({ _id: carId, isActive: true });
  if (!car) throw new AppError(MSG.MSG61.message, 404, MSG.MSG61.code);

  assertNotSold(car);

  const imgIndex = car.images.findIndex((img) => img._id.toString() === imageId);
  if (imgIndex === -1) {
    throw new AppError(MSG.MSG60.message, MSG.MSG60.httpStatus, MSG.MSG60.code);
  }

  const removedImage = car.images[imgIndex];
  await deleteFromCloudinary(removedImage.publicId);
  car.images.splice(imgIndex, 1);

  // If the removed image was primary, promote the first remaining
  if (removedImage.isPrimary && car.images.length > 0) {
    car.images[0].isPrimary = true;
  }

  car.updatedBy = userId;
  await car.save();

  await ActivityLog.log({
    eventType:   ActivityEventType.CAR_IMAGE_REMOVED,
    performedBy: userId,
    targetModel: 'Car',
    targetId:    car._id,
    targetCode:  car.vehicleCode,
    summary:     `Image removed from ${car.vehicleCode}`,
    ipAddress,
  });

  return car;
};

/**
 * Soft-deletes a vehicle (isActive = false). GBR-25.
 * Only allowed for non-SOLD vehicles that have not been publicly listed.
 *
 * @param {object} params
 * @param {string} params.carId
 * @param {string} params.userId
 * @param {string} [params.ipAddress]
 */
export const softDeleteCar = async ({ carId, userId, ipAddress }) => {
  const car = await Car.findOne({ _id: carId, isActive: true });
  if (!car) throw new AppError(MSG.MSG61.message, 404, MSG.MSG61.code);

  assertNotSold(car);

  car.isActive  = false;
  car.updatedBy = userId;
  await car.save({ validateBeforeSave: false });

  await ActivityLog.log({
    eventType:   ActivityEventType.CAR_STATUS_CHANGED,
    performedBy: userId,
    targetModel: 'Car',
    targetId:    car._id,
    targetCode:  car.vehicleCode,
    summary:     `Vehicle ${car.vehicleCode} soft-deleted`,
    ipAddress,
  });
};

export default {
  createCar,
  getCars,
  getCarById,
  updateCar,
  updateCarStatus,
  uploadCarImages,
  deleteCarImage,
  softDeleteCar,
};
