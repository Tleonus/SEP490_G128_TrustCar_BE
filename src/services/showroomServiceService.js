/**
 * @file showroomServiceService.js
 * @description Business logic for the KAN-96 Showroom Service CRUD.
 *
 * Soft-delete only: the DELETE endpoint flips `status` to INACTIVE so that
 * historical Appointment.service references still resolve. Admin can
 * re-activate by PUT { status: 'ACTIVE' }.
 */

import ShowroomService from '../models/showroom-service.model.js';
import { RecordStatus } from '../models/extendedEnums.js';
import { AppError, parsePagination, buildPaginationMeta } from '../utils/apiResponse.js';

const notFound = () => new AppError('Service not found.', 404, 'SERVICE_NOT_FOUND');
const duplicateCode = () => new AppError('Service code already exists.', 409, 'DUPLICATE_SERVICE_CODE');

/** Allow-list the public shape (admin view). */
const toAdminDto = (doc) => ({
  id:                String(doc._id),
  code:              doc.code,
  serviceName:       doc.serviceName,
  description:       doc.description ?? null,
  estimatedDuration: doc.estimatedDuration,
  referencePrice:    doc.referencePrice,
  status:            doc.status,
  createdAt:         doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
  updatedAt:         doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
});

/** Public card (hides audit + status). */
export const toPublicDto = (doc) => ({
  id:                String(doc._id),
  code:              doc.code,
  serviceName:       doc.serviceName,
  description:       doc.description ?? null,
  estimatedDuration: doc.estimatedDuration,
  referencePrice:    doc.referencePrice,
});

/** List ACTIVE packages, sorted by name (public). */
export const listPublicServices = async () => {
  const docs = await ShowroomService
    .find({ status: RecordStatus.ACTIVE })
    .sort({ serviceName: 1 })
    .lean();
  return docs.map(toPublicDto);
};

/** List all (admin). Filter by status/search + paginate. */
export const listAdminServices = async (query) => {
  const { page, limit, skip } = parsePagination(query, 50);
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.search) {
    const needle = String(query.search).trim();
    if (needle) {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { serviceName: { $regex: escaped, $options: 'i' } },
        { code:        { $regex: `^${escaped}`, $options: 'i' } },
      ];
    }
  }
  const [total, docs] = await Promise.all([
    ShowroomService.countDocuments(filter),
    ShowroomService.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return {
    items: docs.map(toAdminDto),
    pagination: buildPaginationMeta(total, page, limit),
  };
};

export const getAdminService = async (id) => {
  const doc = await ShowroomService.findById(id).lean();
  if (!doc) throw notFound();
  return toAdminDto(doc);
};

/** Resolve a package the customer booking flow is allowed to use. */
export const resolveBookableService = async (id, { session = null } = {}) => {
  const query = ShowroomService.findById(id);
  if (session) query.session(session);
  const doc = await query.lean();
  if (!doc) throw notFound();
  if (doc.status !== RecordStatus.ACTIVE) {
    throw new AppError('This service package is no longer available.', 400, 'SERVICE_UNAVAILABLE');
  }
  return doc;
};

export const createService = async (payload, userId) => {
  try {
    const doc = await ShowroomService.create({ ...payload, createdBy: userId, updatedBy: userId });
    const stored = typeof doc?.toObject === 'function' ? doc.toObject() : doc;
    return toAdminDto(stored);
  } catch (error) {
    if (error?.code === 11000) throw duplicateCode();
    throw error;
  }
};

export const updateService = async (id, payload, userId) => {
  // `code` is immutable (stable snapshot key) — reject attempts to change it.
  if (Object.prototype.hasOwnProperty.call(payload, 'code')) {
    throw new AppError('Service code cannot be changed.', 400, 'SERVICE_CODE_IMMUTABLE');
  }
  const doc = await ShowroomService.findByIdAndUpdate(
    id,
    { $set: { ...payload, updatedBy: userId } },
    { new: true, runValidators: true },
  ).lean();
  if (!doc) throw notFound();
  return toAdminDto(doc);
};

/** Soft-delete: set status INACTIVE. */
export const deactivateService = async (id, userId) => {
  const doc = await ShowroomService.findByIdAndUpdate(
    id,
    { $set: { status: RecordStatus.INACTIVE, updatedBy: userId } },
    { new: true },
  ).lean();
  if (!doc) throw notFound();
  return toAdminDto(doc);
};

export default {
  listPublicServices, listAdminServices, getAdminService,
  resolveBookableService, createService, updateService, deactivateService,
  toPublicDto,
};
