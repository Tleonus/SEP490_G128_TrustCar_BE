/**
 * @file carController.js
 * @description Vehicle inventory management controller for showroom staff and admin.
 * Contains ZERO business logic; delegates everything to carService.js.
 *
 * Routes handled:
 * - POST   /api/v1/manage/cars                     → createCar
 * - GET    /api/v1/manage/cars                     → listCars
 * - GET    /api/v1/manage/cars/:id                 → getCarById
 * - PUT    /api/v1/manage/cars/:id                 → updateCar
 * - PATCH  /api/v1/manage/cars/:id/status          → updateCarStatus
 * - POST   /api/v1/manage/cars/:id/images          → uploadImages
 * - DELETE /api/v1/manage/cars/:id/images/:imageId → deleteImage
 * - DELETE /api/v1/manage/cars/:id                 → softDeleteCar
 */

import * as carService from '../services/carService.js';
import { sendSuccess, sendPaginated } from '../utils/apiResponse.js';

/**
 * @route   POST /api/v1/manage/cars
 * @access  Staff & Admin (car:create)
 * @body    Vehicle intake data (see carRoutes DTO schema)
 */
export const createCar = async (req, res, next) => {
  try {
    const car = await carService.createCar(req.body, req.userId, req.ip);
    return sendSuccess(res, 201, 'Vehicle record created successfully.', car);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/v1/manage/cars
 * @access  Staff & Admin (car:read)
 * @query   { page, limit, status, make, model, year, search, sortBy, sortDir }
 */
export const listCars = async (req, res, next) => {
  try {
    const { items, pagination } = await carService.getCars(req.query);
    return sendPaginated(res, 'Vehicles retrieved successfully.', items, pagination);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/v1/manage/cars/:id
 * @access  Staff & Admin (car:read)
 */
export const getCarById = async (req, res, next) => {
  try {
    const car = await carService.getCarById(req.params.id);
    return sendSuccess(res, 200, 'Vehicle retrieved successfully.', car);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PUT /api/v1/manage/cars/:id
 * @access  Staff & Admin (car:update)
 * @body    Updatable fields (validated by DTO schema in routes)
 */
export const updateCar = async (req, res, next) => {
  try {
    const car = await carService.updateCar({
      carId:     req.params.id,
      updates:   req.body,
      userId:    req.userId,
      ipAddress: req.ip,
    });
    return sendSuccess(res, 200, 'Vehicle updated successfully.', car);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PATCH /api/v1/manage/cars/:id/status
 * @access  Staff & Admin (car:status_change)
 * @body    { status: CarStatus, reason?: string }
 */
export const updateCarStatus = async (req, res, next) => {
  try {
    const car = await carService.updateCarStatus({
      carId:        req.params.id,
      targetStatus: req.body.status,
      reason:       req.body.reason,
      userId:       req.userId,
      ipAddress:    req.ip,
    });
    return sendSuccess(res, 200, `Vehicle status updated to ${car.status}.`, car);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/v1/manage/cars/:id/images
 * @access  Staff & Admin (car:image_manage)
 * @files   images[] (via uploadMultiple middleware)
 * @body    { setFirstAsPrimary?: boolean }
 */
export const uploadImages = async (req, res, next) => {
  try {
    const files = req.files || [];
    const car   = await carService.uploadCarImages({
      carId:            req.params.id,
      files,
      setFirstAsPrimary: req.body.setFirstAsPrimary === 'true' || req.body.setFirstAsPrimary === true,
      userId:           req.userId,
      ipAddress:        req.ip,
    });
    return sendSuccess(res, 200, `${files.length} image(s) uploaded successfully.`, {
      images: car.images,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   DELETE /api/v1/manage/cars/:id/images/:imageId
 * @access  Staff & Admin (car:image_manage)
 */
export const deleteImage = async (req, res, next) => {
  try {
    const car = await carService.deleteCarImage({
      carId:     req.params.id,
      imageId:   req.params.imageId,
      userId:    req.userId,
      ipAddress: req.ip,
    });
    return sendSuccess(res, 200, 'Image removed successfully.', {
      images: car.images,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   DELETE /api/v1/manage/cars/:id
 * @access  Admin only (car:delete)
 * @desc    Soft-delete; sets isActive=false (GBR-25)
 */
export const softDeleteCar = async (req, res, next) => {
  try {
    await carService.softDeleteCar({
      carId:     req.params.id,
      userId:    req.userId,
      ipAddress: req.ip,
    });
    return sendSuccess(res, 200, 'Vehicle record deactivated (soft-deleted).');
  } catch (error) {
    next(error);
  }
};

export default {
  createCar,
  listCars,
  getCarById,
  updateCar,
  updateCarStatus,
  uploadImages,
  deleteImage,
  softDeleteCar,
};
