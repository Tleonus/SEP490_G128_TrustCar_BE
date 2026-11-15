/**
 * @file depositRoutes.js
 * @description KAN-22 – Car Deposit & Online Hold routes, mounted at /api/v1/deposits.
 *
 *   GET    /cars/:carKey/hold-status  public (optionalAuth)  – car state + countdown data (serverTime)
 *   POST   /                          CUSTOMER               – place a deposit / hold
 *   GET    /me                        CUSTOMER               – my deposit history
 *   GET    /                          ADMIN, SALES_STAFF     – list deposits (filter by car/user/status…)
 *   GET    /:id                       owner or staff         – deposit detail
 *   PATCH  /:id/cancel                owner (unpaid) / staff – cancel the hold, car → AVAILABLE
 *   PATCH  /:id/confirm-payment       ADMIN, SALES_STAFF     – deposit money received
 *   PATCH  /:id/complete              ADMIN, SALES_STAFF     – full payment received, car → SOLD
 *   PATCH  /:id/refund                ADMIN                  – record refund of a paid deposit
 *
 * Registration (one line in src/routes/index.js – see docs/KAN-22-deposit-integration.md):
 *   router.use('/deposits', depositRoutes);
 */

import { Router } from 'express';
import Joi from 'joi';
import rateLimit from 'express-rate-limit';
import * as depositController from '../controllers/depositController.js';
import { verifyToken, optionalAuth } from '../middlewares/authMiddleware.js';
import { requireRole } from '../middlewares/roleMiddleware.js';
import { validate, validateQuery, validateParams } from '../middlewares/validateMiddleware.js';
import { Roles } from '../constants/appConstants.js';
import { DepositStatus, DepositPaymentStatus } from '../constants/depositConstants.js';

const router = Router();

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const CAR_KEY = /^([0-9a-fA-F]{24}|[A-Za-z0-9-]{3,40})$/;
const STAFF = [Roles.ADMIN, Roles.SALES_STAFF];
const statusList = Object.values(DepositStatus);
const paymentStatusList = Object.values(DepositPaymentStatus);

// ── DTO Schemas ────────────────────────────────────────────────────────────

const createDepositSchema = Joi.object({
  carId: Joi.string().trim().pattern(CAR_KEY).required().messages({
    'any.required': 'carId is required.',
    'string.empty': 'carId is required.',
    'string.pattern.base': 'carId must be a vehicle ObjectId or vehicle code.',
  }),
  depositAmount: Joi.number().integer().positive().max(1e12).required().messages({
    'any.required': 'depositAmount is required.',
    'number.base': 'depositAmount must be a number (VND).',
    'number.integer': 'depositAmount must be an integer amount of VND.',
    'number.positive': 'depositAmount must be greater than 0.',
  }),
  // Accepted for the Jira contract only; the service rejects it unless it equals the JWT user.
  userId: Joi.string().pattern(OBJECT_ID).messages({
    'string.pattern.base': 'userId must be a valid 24-character MongoDB ObjectId.',
  }),
});

const cancelSchema = Joi.object({
  reason: Joi.string().trim().max(500).allow('', null),
});

const paymentSchema = Joi.object({
  paymentReference: Joi.string().trim().max(100).allow('', null),
  note: Joi.string().trim().max(500).allow('', null),
});

const refundSchema = Joi.object({
  refundAmount: Joi.number().integer().min(0).max(1e12).required(),
  refundReference: Joi.string().trim().max(100).allow('', null),
  note: Joi.string().trim().max(500).allow('', null),
});

const idParamSchema = Joi.object({
  id: Joi.string().pattern(OBJECT_ID).required().messages({
    'string.pattern.base': 'id must be a valid 24-character MongoDB ObjectId.',
  }),
});

const carKeyParamSchema = Joi.object({
  carKey: Joi.string().pattern(CAR_KEY).required(),
});

const myListQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(10),
  status: Joi.string().valid(...statusList),
  paymentStatus: Joi.string().valid(...paymentStatusList),
});

const staffListQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid(...statusList),
  paymentStatus: Joi.string().valid(...paymentStatusList),
  carId: Joi.string().pattern(OBJECT_ID),
  userId: Joi.string().pattern(OBJECT_ID),
  depositCode: Joi.string().trim().max(30),
  activeOnly: Joi.boolean().default(false),
  reviewRequired: Joi.boolean().default(false),
});

// Extra throttle on the create endpoint (runs after verifyToken, so req.userId is set).
const createDepositLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `deposit:${req.userId}`,
  message: { success: false, code: 'RATE_LIMIT_EXCEEDED', message: 'Bạn thao tác đặt cọc quá nhiều lần. Vui lòng thử lại sau.' },
});

// ── Routes ────────────────────────────────────────────────────────────────

router.get('/cars/:carKey/hold-status', optionalAuth, validateParams(carKeyParamSchema), depositController.getCarHoldStatus);

router.post(
  '/',
  verifyToken,
  requireRole(Roles.CUSTOMER),
  createDepositLimiter,
  validate(createDepositSchema),
  depositController.createDeposit,
);

router.get('/me', verifyToken, requireRole(Roles.CUSTOMER), validateQuery(myListQuerySchema), depositController.listMyDeposits);

router.get('/', verifyToken, requireRole(...STAFF), validateQuery(staffListQuerySchema), depositController.listDeposits);

router.get('/:id', verifyToken, requireRole(Roles.CUSTOMER, ...STAFF), validateParams(idParamSchema), depositController.getDeposit);

router.patch(
  '/:id/cancel',
  verifyToken,
  requireRole(Roles.CUSTOMER, ...STAFF),
  validateParams(idParamSchema),
  validate(cancelSchema),
  depositController.cancelDeposit,
);

router.patch(
  '/:id/confirm-payment',
  verifyToken,
  requireRole(...STAFF),
  validateParams(idParamSchema),
  validate(paymentSchema),
  depositController.confirmDepositPayment,
);

router.patch(
  '/:id/complete',
  verifyToken,
  requireRole(...STAFF),
  validateParams(idParamSchema),
  validate(paymentSchema),
  depositController.completeDeposit,
);

router.patch(
  '/:id/refund',
  verifyToken,
  requireRole(Roles.ADMIN),
  validateParams(idParamSchema),
  validate(refundSchema),
  depositController.refundDeposit,
);

export default router;
