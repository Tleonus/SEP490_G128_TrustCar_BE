/**
 * @file serviceAppointmentController.js
 * @description Customer-facing endpoints for KAN-96 showroom service appointments.
 *
 * Mounted under /api/v1/customer/appointments/service, guarded by the same
 * verifyToken + CUSTOMER role check as the test-drive routes.
 */

import * as service from '../services/serviceAppointmentService.js';
import { sendSuccess, sendPaginated } from '../utils/apiResponse.js';

const who = (req) => ({ customerId: req.user.customer, userId: req.userId });

/** GET /customer/appointments/service/slots?from&to */
export const getServiceSlots = async (req, res, next) => {
  try {
    const data = await service.listServiceSlots({
      customerId: who(req).customerId,
      from: req.query.from,
      to: req.query.to,
    });
    return sendSuccess(res, 200, 'Service slots retrieved successfully.', data);
  } catch (error) { return next(error); }
};

/** POST /customer/appointments/service */
export const createService = async (req, res, next) => {
  try {
    const dto = await service.createServiceAppointment({
      ...who(req),
      serviceId: req.body.serviceId,
      scheduledAt: new Date(req.body.scheduledAt),
      serviceVehiclePlate: req.body.serviceVehiclePlate,
      notes: req.body.notes ?? null,
    });
    return sendSuccess(res, 201, 'Service appointment created.', dto);
  } catch (error) { return next(error); }
};

/** GET /customer/appointments/service */
export const listMine = async (req, res, next) => {
  try {
    const { items, pagination } = await service.listMyServiceAppointments({
      customerId: who(req).customerId, query: req.query,
    });
    return sendPaginated(res, 'Service appointments retrieved successfully.', items, pagination);
  } catch (error) { return next(error); }
};

/** PATCH /customer/appointments/service/:id/cancel */
export const cancelMine = async (req, res, next) => {
  try {
    const dto = await service.cancelMyServiceAppointment({
      ...who(req), id: req.params.id, reason: req.body.reason ?? null,
    });
    return sendSuccess(res, 200, 'Service appointment cancelled.', dto);
  } catch (error) { return next(error); }
};

export default { getServiceSlots, createService, listMine, cancelMine };
