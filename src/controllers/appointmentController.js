/**
 * @file appointmentController.js
 * @description Staff test-drive appointment controller (ADMIN / SALES_STAFF).
 * Contains ZERO business logic; delegates to appointmentStaffService.
 *
 * Routes handled (/api/v1/appointments):
 * - GET   /             → list
 * - GET   /:id          → getOne
 * - PATCH /:id/status   → changeStatus
 * - PATCH /:id/reschedule → reschedule
 * - GET   /slots        → slots
 * - GET   /customers    → customers
 * - POST  /             → createForCustomer
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-018…021)
 */

import { listVisits, getVisit, changeVisitStatus } from '../services/appointmentStaffService.js';
import { rescheduleVisitAsStaff } from '../services/appointmentRescheduleService.js';
import { getStaffSlots } from '../services/appointmentStaffSlotService.js';
import { searchCustomersForStaff, createVisitForCustomer } from '../services/appointmentStaffBookingService.js';
import { sendSuccess, sendPaginated } from '../utils/apiResponse.js';

export const list = async (req, res, next) => {
  try {
    const { visits, pagination } = await listVisits({ query: req.query, userId: req.userId, ipAddress: req.ip });
    return sendPaginated(res, 'Visits retrieved successfully.', visits, pagination);
  } catch (error) {
    return next(error);
  }
};

export const getOne = async (req, res, next) => {
  try {
    const visit = await getVisit({ id: req.params.id });
    return sendSuccess(res, 200, 'Visit retrieved successfully.', { visit });
  } catch (error) {
    return next(error);
  }
};

export const changeStatus = async (req, res, next) => {
  try {
    const { status, reason, reasonCode, outcome } = req.body;
    const visit = await changeVisitStatus({
      id: req.params.id, userId: req.userId, status, reason, reasonCode, outcome, ipAddress: req.ip,
    });
    return sendSuccess(res, 200, 'Visit status updated successfully.', { visit });
  } catch (error) {
    return next(error);
  }
};

export const reschedule = async (req, res, next) => {
  try {
    const { visit, previousVisitCode } = await rescheduleVisitAsStaff({
      id: req.params.id, userId: req.userId, scheduledAt: req.body.scheduledAt, ipAddress: req.ip,
    });
    return sendSuccess(res, 200, 'Visit rescheduled successfully.', { visit, previousVisitCode });
  } catch (error) {
    return next(error);
  }
};

export const slots = async (req, res, next) => {
  try {
    const { from, to, carIds, excludeVisitId } = req.query;
    const data = await getStaffSlots({ from, to, carIds, excludeVisitId });
    return sendSuccess(res, 200, 'Visit slots retrieved successfully.', data);
  } catch (error) {
    return next(error);
  }
};

export const customers = async (req, res, next) => {
  try {
    const data = await searchCustomersForStaff({ q: req.query.q });
    return sendSuccess(res, 200, 'Customers retrieved successfully.', data);
  } catch (error) {
    return next(error);
  }
};

export const createForCustomer = async (req, res, next) => {
  try {
    const { customerId, carIds, scheduledAt, notes } = req.body;
    const visit = await createVisitForCustomer({
      userId: req.userId, customerId, carIds, scheduledAt, notes, ipAddress: req.ip,
    });
    return sendSuccess(res, 201, 'Test-drive visit booked successfully.', { visit });
  } catch (error) {
    return next(error);
  }
};

export default { list, getOne, changeStatus, reschedule, slots, customers, createForCustomer };
