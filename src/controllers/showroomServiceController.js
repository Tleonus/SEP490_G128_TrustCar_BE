/**
 * @file showroomServiceController.js
 * @description HTTP controllers for KAN-96 Showroom Service CRUD.
 *
 * Public:
 *   GET    /public/services                 → listPublic
 * Manage (verifyToken + service permission):
 *   GET    /manage/services                 → list    (service:read)
 *   GET    /manage/services/:id             → getOne  (service:read)
 *   POST   /manage/services                 → create  (service:write)
 *   PUT    /manage/services/:id             → update  (service:write)
 *   DELETE /manage/services/:id             → remove  (service:write, soft-delete)
 */

import * as service from '../services/showroomServiceService.js';
import { sendSuccess, sendPaginated } from '../utils/apiResponse.js';

export const listPublic = async (_req, res, next) => {
  try {
    const items = await service.listPublicServices();
    return sendSuccess(res, 200, 'Service packages fetched.', items);
  } catch (error) { return next(error); }
};

export const list = async (req, res, next) => {
  try {
    const { items, pagination } = await service.listAdminServices(req.query);
    return sendPaginated(res, 'Service packages fetched.', items, pagination);
  } catch (error) { return next(error); }
};

export const getOne = async (req, res, next) => {
  try {
    const dto = await service.getAdminService(req.params.id);
    return sendSuccess(res, 200, 'Service package fetched.', dto);
  } catch (error) { return next(error); }
};

export const create = async (req, res, next) => {
  try {
    const dto = await service.createService(req.body, req.userId);
    return sendSuccess(res, 201, 'Service package created.', dto);
  } catch (error) { return next(error); }
};

export const update = async (req, res, next) => {
  try {
    const dto = await service.updateService(req.params.id, req.body, req.userId);
    return sendSuccess(res, 200, 'Service package updated.', dto);
  } catch (error) { return next(error); }
};

export const remove = async (req, res, next) => {
  try {
    const dto = await service.deactivateService(req.params.id, req.userId);
    return sendSuccess(res, 200, 'Service package deactivated.', dto);
  } catch (error) { return next(error); }
};

export default { listPublic, list, getOne, create, update, remove };
