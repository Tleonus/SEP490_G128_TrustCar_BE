/**
 * @file testDriveController.js
 * @description Maps test-drive requests to services and responses; no business logic.
 */

import * as availability from '../services/testDriveAvailabilityService.js';
import * as booking from '../services/testDriveBookingService.js';
import * as customerService from '../services/testDriveCustomerService.js';
import * as staffService from '../services/testDriveStaffService.js';
import { parsePagination, sendPaginated, sendSuccess } from '../utils/apiResponse.js';

/** Wraps a handler so a rejected promise reaches the error middleware. */
const handle = (fn) => (req, res, next) => fn(req, res).catch(next);

export const getCarSlots = handle(async (req, res) => {
  const slots = await availability.getCarSlots(req.params.carId, req.query.date);
  return sendSuccess(res, 200, 'Test-drive slots retrieved successfully.', slots);
});

export const book = handle(async (req, res) => {
  const appointment = await booking.bookOnline({ user: req.user, ...req.body });
  return sendSuccess(res, 201, 'Test drive booked successfully.', appointment);
});

export const listMine = handle(async (req, res) => {
  const { items, pagination } = await customerService.listMine(req.user, parsePagination(req.query));
  return sendPaginated(res, 'Test drives retrieved successfully.', items, pagination);
});

export const cancelMine = handle(async (req, res) => {
  const appointment = await customerService.cancelMine(req.user, req.params.id);
  return sendSuccess(res, 200, 'Test drive cancelled successfully.', appointment);
});

export const list = handle(async (req, res) => {
  const { items, pagination } = await staffService.listAppointments(req.query, parsePagination(req.query));
  return sendPaginated(res, 'Test drives retrieved successfully.', items, pagination);
});

export const assign = handle(async (req, res) => {
  const result = await staffService.reassign(req.params.id, req.body.staffId, req.user);
  return sendSuccess(res, 200, 'Test drive reassigned successfully.', result);
});

export const confirm = handle(async (req, res) => {
  const result = await staffService.confirm(req.params.id, req.user);
  return sendSuccess(res, 200, 'Test drive confirmed successfully.', result);
});

export const staffCancel = handle(async (req, res) => {
  const result = await staffService.staffCancel(req.params.id, req.body, req.user);
  return sendSuccess(res, 200, 'Test drive cancelled successfully.', result);
});

export const complete = handle(async (req, res) => {
  const result = await staffService.complete(req.params.id, req.body.outcome, req.user);
  return sendSuccess(res, 200, 'Test drive completed successfully.', result);
});

export const noShow = handle(async (req, res) => {
  const result = await staffService.markNoShow(req.params.id, req.user);
  return sendSuccess(res, 200, 'Test drive marked as no-show.', result);
});

export const correctNoShow = handle(async (req, res) => {
  const result = await staffService.correctNoShow(req.params.id, req.body.outcome, req.user);
  return sendSuccess(res, 200, 'No-show corrected successfully.', result);
});

export default { getCarSlots, book, listMine, cancelMine, list, assign, confirm, staffCancel, complete, noShow, correctNoShow };
