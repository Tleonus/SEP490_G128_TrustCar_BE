/**
 * @file depositController.js
 * @description KAN-22 – HTTP layer for Car Deposit & Online Hold.
 * Contains no business logic; delegates to depositService.js.
 * The acting user is always req.user (verified JWT).
 */

import * as depositService from '../services/depositService.js';
import { sendSuccess, sendPaginated } from '../utils/apiResponse.js';

const requestContext = (req) => ({ ipAddress: req.ip, userAgent: req.get('user-agent') || null });

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

/** @route POST /api/v1/deposits  (CUSTOMER) */
export const createDeposit = handle(async (req, res) => {
  const data = await depositService.createDeposit({
    user: req.user,
    carId: req.body.carId,
    depositAmount: req.body.depositAmount,
    userId: req.body.userId, // optional – must equal the JWT account (checked in the service)
    paymentProvider: req.body.paymentProvider, // KAN-99: MANUAL | VNPAY (defaults in service)
    ...requestContext(req),
  });
  return sendSuccess(res, 201, 'Đặt cọc giữ xe thành công.', data);
});

/** @route GET /api/v1/deposits/cars/:carKey/hold-status  (public, optional auth) */
export const getCarHoldStatus = handle(async (req, res) => {
  const data = await depositService.getCarHoldStatus(req.params.carKey, req.user || null);
  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, 200, 'Car hold status retrieved.', data);
});

/** @route GET /api/v1/deposits/me  (CUSTOMER) */
export const listMyDeposits = handle(async (req, res) => {
  const { items, pagination } = await depositService.listMyDeposits({ user: req.user, query: req.query });
  return sendPaginated(res, 'Deposit history retrieved.', items, pagination);
});

/** @route GET /api/v1/deposits  (ADMIN, SALES_STAFF) */
export const listDeposits = handle(async (req, res) => {
  const { items, pagination } = await depositService.listDepositsForStaff({ query: req.query });
  return sendPaginated(res, 'Deposits retrieved.', items, pagination);
});

/** @route GET /api/v1/deposits/:id  (owner or staff) */
export const getDeposit = handle(async (req, res) => {
  const data = await depositService.getDepositById({ user: req.user, depositId: req.params.id });
  return sendSuccess(res, 200, 'Deposit retrieved.', data);
});

/** @route PATCH /api/v1/deposits/:id/cancel  (owner: unpaid only; staff: any active) */
export const cancelDeposit = handle(async (req, res) => {
  const data = await depositService.cancelDeposit({
    user: req.user,
    depositId: req.params.id,
    reason: req.body?.reason,
    ...requestContext(req),
  });
  return sendSuccess(res, 200, 'Đã hủy lượt giữ xe.', data);
});

/** @route PATCH /api/v1/deposits/:id/confirm-payment  (ADMIN, SALES_STAFF) – deposit received */
export const confirmDepositPayment = handle(async (req, res) => {
  const data = await depositService.confirmDepositPayment({
    user: req.user,
    depositId: req.params.id,
    paymentReference: req.body.paymentReference,
    note: req.body.note,
    ...requestContext(req),
  });
  return sendSuccess(res, 200, 'Đã xác nhận nhận tiền cọc.', data);
});

/** @route PATCH /api/v1/deposits/:id/complete  (ADMIN, SALES_STAFF) – full payment received, car SOLD */
export const completeDeposit = handle(async (req, res) => {
  const data = await depositService.completeDeposit({
    user: req.user,
    depositId: req.params.id,
    paymentReference: req.body.paymentReference,
    note: req.body.note,
    ...requestContext(req),
  });
  return sendSuccess(res, 200, 'Đã xác nhận thanh toán đủ. Xe chuyển sang Đã bán.', data);
});

/** @route PATCH /api/v1/deposits/:id/refund  (ADMIN) – record a refund of a paid deposit */
export const refundDeposit = handle(async (req, res) => {
  const data = await depositService.refundDeposit({
    user: req.user,
    depositId: req.params.id,
    refundAmount: req.body.refundAmount,
    refundReference: req.body.refundReference,
    note: req.body.note,
    ...requestContext(req),
  });
  return sendSuccess(res, 200, 'Đã ghi nhận hoàn cọc.', data);
});

export default {
  createDeposit, getCarHoldStatus, listMyDeposits, listDeposits, getDeposit, cancelDeposit,
  confirmDepositPayment, completeDeposit, refundDeposit,
};
