/**
 * @file customerAppointmentController.js
 * @description Customer test-drive booking controller. Contains ZERO business logic;
 * delegates to the appointment services.
 *
 * Routes handled (/api/v1/customer/appointments):
 * - GET   /slots       → getSlots
 * - POST  /            → createVisit
 * - GET   /            → listMine
 * - GET   /:id         → getMine
 * - PATCH /:id/cancel  → cancelMine
 * - PATCH /:id/reschedule → rescheduleMine
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-003, 013…017)
 */

import { createVisit } from '../services/appointmentBookingService.js';
import { rescheduleMyVisit } from '../services/appointmentRescheduleService.js';
import { getSlots as loadSlots } from '../services/appointmentSlotService.js';
import { listMyVisits, getMyVisit, cancelMyVisit } from '../services/appointmentCustomerService.js';
import { sendSuccess, sendPaginated } from '../utils/apiResponse.js';

/** The logged-in customer: `customer` is the Customer document linked to the user. */
const who = (req) => ({ customerId: req.user.customer, userId: req.userId });

export const getSlots = async (req, res, next) => {
  try {
    const { carIds, from, to, excludeVisitId } = req.query;
    const data = await loadSlots({ customerId: req.user.customer, carIds, from, to, excludeVisitId });
    return sendSuccess(res, 200, 'Visit slots retrieved successfully.', data);
  } catch (error) {
    return next(error);
  }
};

export const createVisitHandler = async (req, res, next) => {
  try {
    const { carIds, scheduledAt, notes } = req.body;
    const visit = await createVisit({ ...who(req), carIds, scheduledAt, notes, ipAddress: req.ip });
    return sendSuccess(res, 201, 'Test-drive visit booked successfully.', { visit });
  } catch (error) {
    return next(error);
  }
};

export const listMine = async (req, res, next) => {
  try {
    const { visits, pagination } = await listMyVisits({ customerId: req.user.customer, query: req.query });
    return sendPaginated(res, 'Visits retrieved successfully.', visits, pagination);
  } catch (error) {
    return next(error);
  }
};

export const getMine = async (req, res, next) => {
  try {
    const visit = await getMyVisit({ customerId: req.user.customer, id: req.params.id });
    return sendSuccess(res, 200, 'Visit retrieved successfully.', { visit });
  } catch (error) {
    return next(error);
  }
};

export const cancelMine = async (req, res, next) => {
  try {
    const visit = await cancelMyVisit({ ...who(req), id: req.params.id, reason: req.body.reason, ipAddress: req.ip });
    return sendSuccess(res, 200, 'Visit cancelled successfully.', { visit });
  } catch (error) {
    return next(error);
  }
};

export const rescheduleMine = async (req, res, next) => {
  try {
    const { visit, previousVisitCode } = await rescheduleMyVisit({
      ...who(req), id: req.params.id, scheduledAt: req.body.scheduledAt, ipAddress: req.ip,
    });
    return sendSuccess(res, 200, 'Visit rescheduled successfully.', { visit, previousVisitCode });
  } catch (error) {
    return next(error);
  }
};

export default { getSlots, createVisitHandler, listMine, getMine, cancelMine, rescheduleMine };
