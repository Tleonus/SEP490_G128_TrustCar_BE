/**
 * @file carRoutes.js
 * @description Protected vehicle inventory management routes (/api/v1/manage/cars).
 * Requires authentication + appropriate car:* permission (Staff & Admin).
 */

import { Router } from 'express';
import Joi from 'joi';
import * as carController from '../controllers/carController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requirePermission, requireAdmin } from '../middlewares/roleMiddleware.js';
import { validate, validateParams, objectIdParamSchema } from '../middlewares/validateMiddleware.js';
import { uploadMultiple, requireFile } from '../middlewares/uploadMiddleware.js';
import { Permissions, CarStatus, FuelType, Transmission, DriveType, BodyType } from '../constants/appConstants.js';
import { joiVIN, joiPlate, joiVehicleYear, joiPrice } from '../utils/validators.js';

const router = Router();

// Auth guard on all routes
router.use(verifyToken);

// ── DTO Schemas ────────────────────────────────────────────────────────────

const createCarSchema = Joi.object({
  vin:          joiVIN().required(),
  licensePlate: joiPlate().required(),

  make:    Joi.string().trim().uppercase().max(60).required(),
  model:   Joi.string().trim().max(100).required(),
  variant: Joi.string().trim().max(100).optional(),

  year:         joiVehicleYear().required(),
  bodyType:     Joi.string().valid(...Object.values(BodyType)).optional(),
  fuelType:     Joi.string().valid(...Object.values(FuelType)).optional(),
  transmission: Joi.string().valid(...Object.values(Transmission)).optional(),
  driveType:    Joi.string().valid(...Object.values(DriveType)).optional(),

  mileage:  Joi.number().integer().min(0).default(0),
  price:    joiPrice().required(),

  description:    Joi.string().trim().max(5000).optional(),
  conditionGrade: Joi.string().valid('A', 'B', 'C', 'D').optional(),
  internalNotes:  Joi.string().trim().max(2000).optional(),

  registrationExpiry: Joi.date().iso().optional(),
  carModelRef:        Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),

  specifications: Joi.object({
    engineDisplacementCC: Joi.number().optional(),
    engineCylinders:      Joi.number().integer().min(1).max(16).optional(),
    horsePower:           Joi.number().optional(),
    torqueNm:             Joi.number().optional(),
    numberOfDoors:        Joi.number().integer().min(2).max(6).optional(),
    numberOfSeats:        Joi.number().integer().min(1).max(20).optional(),
    fuelTankLiters:       Joi.number().optional(),
    fuelConsumption:      Joi.number().optional(),
    safetyRating:         Joi.string().trim().max(50).optional(),
    color:                Joi.string().trim().max(50).optional(),
    interiorColor:        Joi.string().trim().max(50).optional(),
    originCountry:        Joi.string().trim().max(50).optional(),
    importType:           Joi.string().valid('CBU', 'CKD', 'LOCAL').optional(),
    features:             Joi.array().items(Joi.string().max(100)).max(50).optional(),
  }).optional(),
});

const updateCarSchema = Joi.object({
  vin:          joiVIN().optional(),
  licensePlate: joiPlate().optional(),

  make:    Joi.string().trim().uppercase().max(60).optional(),
  model:   Joi.string().trim().max(100).optional(),
  variant: Joi.string().trim().max(100).allow('', null).optional(),
  year:    joiVehicleYear().optional(),

  bodyType:     Joi.string().valid(...Object.values(BodyType)).allow(null).optional(),
  fuelType:     Joi.string().valid(...Object.values(FuelType)).allow(null).optional(),
  transmission: Joi.string().valid(...Object.values(Transmission)).allow(null).optional(),
  driveType:    Joi.string().valid(...Object.values(DriveType)).allow(null).optional(),

  mileage: Joi.number().integer().min(0).optional(),
  price:   joiPrice().optional(),
  priceChangeReason: Joi.string().trim().max(500).optional(),

  description:    Joi.string().trim().max(5000).allow('', null).optional(),
  conditionGrade: Joi.string().valid('A', 'B', 'C', 'D').allow(null).optional(),
  internalNotes:  Joi.string().trim().max(2000).allow('', null).optional(),

  registrationExpiry: Joi.date().iso().allow(null).optional(),
  carModelRef:        Joi.string().pattern(/^[0-9a-fA-F]{24}$/).allow(null).optional(),
  specifications:     Joi.object().optional(),
}).min(1);

const statusUpdateSchema = Joi.object({
  status: Joi.string()
    .valid(...Object.values(CarStatus))
    .required()
    .messages({ 'any.required': 'Target status is required.' }),
  reason: Joi.string().trim().max(500).optional(),
});

const imageParamsSchema = Joi.object({
  id:      Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  imageId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
});

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * @route   POST /api/v1/manage/cars
 * @access  car:create
 */
router.post(
  '/',
  requirePermission(Permissions.CAR_CREATE),
  validate(createCarSchema),
  carController.createCar
);

/**
 * @route   GET /api/v1/manage/cars
 * @access  car:read
 */
router.get(
  '/',
  requirePermission(Permissions.CAR_READ),
  carController.listCars
);

// Featured cars – public-like endpoint (no extra params)
router.get(
  '/featured',
  // No permission needed for featured list (could be public), but keep token guard from router.use(verifyToken)
  // If you want to allow unauthenticated, move this route to publicCarRoutes.
  async (req, res, next) => {
    try {
      const limit = parseInt(req.query.limit, 10) || 8;
      // Import Car and CarStatus inside handler to avoid circular deps
      const Car = (await import('../models/Car.js')).default;
      const { CarStatus } = await import('../constants/appConstants.js');
      const cars = await Car.find({
        status: { $in: [CarStatus.AVAILABLE, CarStatus.APPROVED_CPO] },
        isActive: true,
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      return res.json({ success: true, data: cars });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @route   GET /api/v1/manage/cars/:id
 * @access  car:read
 */
router.get(
  '/:id',
  requirePermission(Permissions.CAR_READ),
  validateParams(objectIdParamSchema),
  carController.getCarById
);

/**
 * @route   PUT /api/v1/manage/cars/:id
 * @access  car:update
 */
router.put(
  '/:id',
  requirePermission(Permissions.CAR_UPDATE),
  validateParams(objectIdParamSchema),
  validate(updateCarSchema),
  carController.updateCar
);

/**
 * @route   PATCH /api/v1/manage/cars/:id/status
 * @access  car:status_change
 */
router.patch(
  '/:id/status',
  requirePermission(Permissions.CAR_STATUS_CHANGE),
  validateParams(objectIdParamSchema),
  validate(statusUpdateSchema),
  carController.updateCarStatus
);

/**
 * @route   POST /api/v1/manage/cars/:id/images
 * @access  car:image_manage
 * @files   images[] (up to 10 per request)
 */
router.post(
  '/:id/images',
  requirePermission(Permissions.CAR_IMAGE_MANAGE),
  validateParams(objectIdParamSchema),
  uploadMultiple(10),
  requireFile,
  carController.uploadImages
);

/**
 * @route   DELETE /api/v1/manage/cars/:id/images/:imageId
 * @access  car:image_manage
 */
router.delete(
  '/:id/images/:imageId',
  requirePermission(Permissions.CAR_IMAGE_MANAGE),
  validateParams(imageParamsSchema),
  carController.deleteImage
);

/**
 * @route   DELETE /api/v1/manage/cars/:id
 * @access  Admin only (car:delete is Admin-only by ROLE_PERMISSIONS)
 */
router.delete(
  '/:id',
  requireAdmin,
  validateParams(objectIdParamSchema),
  carController.softDeleteCar
);

export default router;
