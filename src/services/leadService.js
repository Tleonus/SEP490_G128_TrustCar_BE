/**
 * @file leadService.js
 * @description Lead (CRM sales opportunity) business logic.
 *
 * Two entry points:
 * - createPublicEnquiry(): the visitor-facing contact form. No account, no
 *   token, and possibly no specific vehicle. Resolves or creates the Customer
 *   record by phone, then records the enquiry as a Lead so the sales team can
 *   work it in the pipeline.
 * - listLeads(): paginated read for staff.
 *
 * Ref: KAN-48, GBR-13 (leadCode), GBR-16 (phone normalization), GBR-18 (append-only activities)
 */

import mongoose from 'mongoose';
import Lead from '../models/Lead.js';
import Customer from '../models/Customer.js';
import Car from '../models/Car.js';
import ActivityLog from '../models/ActivityLog.js';
import { generateLeadCode } from '../utils/codeGenerator.js';
import { normalizePhone, isValidVietnamesePhone } from '../utils/validators.js';
import { AppError, buildPaginationMeta } from '../utils/apiResponse.js';
import {
  LeadStage,
  CarStatus,
  ActivityEventType,
  Roles,
} from '../constants/appConstants.js';

/** Attempts to allocate a unique LD-NNNN before giving up (concurrent submits). */
const LEAD_CODE_ATTEMPTS = 5;

/**
 * Finds the showroom Customer record for a phone number, or creates one.
 *
 * The public contact form only knows a name and a phone number — no User
 * account — so this is the only way to satisfy Lead.customer.
 *
 * @param {{ fullName: string, phone: string, email?: string|null }} input
 * @returns {Promise<import('mongoose').Document>} Customer document
 */
const resolveCustomer = async ({ fullName, phone, email = null }) => {
  const existing = await Customer.findOne({ phone, isActive: true });

  if (existing) {
    // Backfill missing contact details without ever overwriting what the
    // sales team may have corrected by hand.
    const patch = {};
    if (!existing.email && email) patch.email = email;
    if (Object.keys(patch).length > 0) {
      await Customer.updateOne({ _id: existing._id }, { $set: patch });
    }
    return existing;
  }

  return Customer.create({
    fullName,
    phone,
    email: email || null,
    source: 'Website',
    notes: 'Created automatically from a public website enquiry.',
  });
};

/**
 * Resolves the vehicle a lead refers to, if any.
 *
 * Accepts either a stock code (TC-YYYY-NNNN) or a MongoDB ObjectId. A car that
 * does not exist, or is not publicly visible, is reported as 404 rather than
 * silently dropped — a lead attached to the wrong vehicle is worse than an
 * error the visitor can act on.
 *
 * @param {string|null|undefined} vehicleCode
 * @returns {Promise<import('mongoose').Types.ObjectId|null>}
 */
const resolveCar = async (vehicleCode) => {
  if (!vehicleCode) return null;

  const key = String(vehicleCode).trim();
  const filter = mongoose.isValidObjectId(key) ? { _id: key } : { vehicleCode: key };

  const car = await Car.findOne(
    { ...filter, isActive: true },
    { _id: 1, vehicleCode: 1, status: 1 }
  ).lean();

  if (!car) {
    throw new AppError(
      'The vehicle you are enquiring about is no longer available.',
      404,
      'CAR_NOT_FOUND'
    );
  }

  const visible = [CarStatus.AVAILABLE, CarStatus.APPROVED_CPO, CarStatus.RESERVED];
  if (!visible.includes(car.status)) {
    throw new AppError(
      'The vehicle you are enquiring about is no longer available.',
      404,
      'CAR_NOT_FOUND'
    );
  }

  return car._id;
};

/**
 * Records a public contact-form enquiry as a Lead.
 *
 * @param {object} payload
 * @param {string} payload.fullName      - Visitor's name, as typed.
 * @param {string} payload.phone         - Visitor's phone, raw (normalized here).
 * @param {string} [payload.email]
 * @param {string} [payload.message]     - Free-text enquiry.
 * @param {string} [payload.vehicleCode] - Stock code or ObjectId, when raised from a car page.
 * @param {string} [payload.pagePath]    - Page the form was submitted from.
 * @param {object} [context]             - { ipAddress, userAgent }
 * @returns {Promise<{ leadCode: string, stage: string, createdAt: Date }>}
 */
export const createPublicEnquiry = async (payload, context = {}) => {
  const phone = normalizePhone(payload.phone);

  if (!isValidVietnamesePhone(phone)) {
    throw new AppError(
      'Phone number must be a valid Vietnamese number (0xxxxxxxxx or +84xxxxxxxxx).',
      422,
      'VALIDATION_ERROR',
      [{ field: 'phone_number', message: 'Số điện thoại không hợp lệ.' }]
    );
  }

  const carId = await resolveCar(payload.vehicleCode);
  const customer = await resolveCustomer({
    fullName: payload.fullName,
    phone,
    email: payload.email || null,
  });

  const enquiry = {
    message:        payload.message || null,
    submittedName:  payload.fullName,
    submittedPhone: phone,
    submittedEmail: payload.email || null,
    pagePath:       payload.pagePath || null,
  };

  // leadCode is unique-indexed: two visitors submitting in the same second can
  // compute the same next number, so retry on a duplicate-key error.
  let lead = null;
  for (let attempt = 1; attempt <= LEAD_CODE_ATTEMPTS; attempt += 1) {
    try {
      lead = await Lead.create({
        leadCode: await generateLeadCode(Lead),
        customer: customer._id,
        car:      carId,
        stage:    LeadStage.NEW,
        source:   carId ? 'Website — Vehicle Enquiry' : 'Website — Contact Form',
        priority: 'MEDIUM',
        enquiry,
        createdBy: null,
        activities: [],
      });
      break;
    } catch (error) {
      const isDuplicateCode =
        error?.code === 11000 && Object.keys(error?.keyPattern || {}).includes('leadCode');
      if (!isDuplicateCode || attempt === LEAD_CODE_ATTEMPTS) throw error;
    }
  }

  await ActivityLog.log({
    eventType:        ActivityEventType.LEAD_CREATED,
    performedBy:      null,
    targetModel:      'Lead',
    targetId:         lead._id,
    targetCode:       lead.leadCode,
    summary:          carId
      ? `Public enquiry received for a vehicle (${lead.leadCode}).`
      : `Public contact-form enquiry received (${lead.leadCode}).`,
    ipAddress:        context.ipAddress || null,
    userAgent:        context.userAgent || null,
    metadata: {
      source:      lead.source,
      customerId:  String(customer._id),
      vehicleCode: payload.vehicleCode || null,
    },
  });

  return {
    leadCode:  lead.leadCode,
    stage:     lead.stage,
    createdAt: lead.createdAt,
  };
};

/**
 * Paginated lead list for staff.
 *
 * @param {object} query - { page, limit, stage, assignedTo, search, hasVehicle }
 * @returns {Promise<{ items: object[], pagination: object }>}
 */
export const listLeads = async (query = {}) => {
  const page  = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));

  const filter = { isActive: true };

  if (query.stage) filter.stage = query.stage;
  if (query.assignedTo) filter.assignedTo = query.assignedTo;

  if (query.hasVehicle === 'true')  filter.car = { $ne: null };
  if (query.hasVehicle === 'false') filter.car = null;

  if (query.search) {
    // Escape regex metacharacters so a search of "(" does not throw.
    const term = String(query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (term) {
      const rx = new RegExp(term, 'i');
      filter.$or = [
        { leadCode:                rx },
        { 'enquiry.submittedName':  rx },
        { 'enquiry.submittedPhone': rx },
        { 'enquiry.submittedEmail': rx },
      ];
    }
  }

  const [items, total] = await Promise.all([
    Lead.find(filter)
      .populate('customer', 'fullName phone email source')
      .populate('car', 'vehicleCode make model year price status')
      .populate('assignedTo', 'fullName email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Lead.countDocuments(filter),
  ]);

  return { items, pagination: buildPaginationMeta(total, page, limit) };
};

/**
 * Lead detail with the full activity timeline.
 *
 * @param {string} id - Lead ObjectId or leadCode (LD-NNNN).
 * @returns {Promise<object>}
 */
export const getLeadById = async (id) => {
  const key = String(id).trim();
  const filter = mongoose.isValidObjectId(key) ? { _id: key } : { leadCode: key };

  const lead = await Lead.findOne({ ...filter, isActive: true })
    .populate('customer', 'fullName phone email address source notes')
    .populate('car', 'vehicleCode make model year price status images')
    .populate('assignedTo', 'fullName email')
    .populate('activities.performedBy', 'fullName email roleName')
    .lean();

  if (!lead) {
    throw new AppError('Lead not found.', 404, 'LEAD_NOT_FOUND');
  }

  return lead;
};

/**
 * Appends a note to the lead timeline. Append-only per GBR-18 — nothing here
 * edits or deletes an existing activity entry.
 *
 * @param {string} id
 * @param {object} input  - { note, performedBy, ipAddress, userAgent }
 * @returns {Promise<object>} The updated lead (lean)
 */
export const addLeadNote = async (id, input) => {
  const key = String(id).trim();
  const filter = mongoose.isValidObjectId(key) ? { _id: key } : { leadCode: key };

  const lead = await Lead.findOneAndUpdate(
    { ...filter, isActive: true },
    {
      $push: {
        activities: {
          type:        'NOTE',
          note:        input.note,
          performedBy: input.performedBy,
          performedAt: new Date(),
        },
      },
      $set: { updatedBy: input.performedBy },
    },
    { new: true }
  ).lean();

  if (!lead) {
    throw new AppError('Lead not found.', 404, 'LEAD_NOT_FOUND');
  }

  await ActivityLog.log({
    eventType:   ActivityEventType.LEAD_NOTE_ADDED,
    performedBy: input.performedBy,
    targetModel: 'Lead',
    targetId:    lead._id,
    targetCode:  lead.leadCode,
    summary:     `Note added to ${lead.leadCode}.`,
    ipAddress:   input.ipAddress || null,
    userAgent:   input.userAgent || null,
  });

  return lead;
};

/**
 * Owner filter helper: an unassigned lead is claimable by any sales user.
 * Used by future "claim lead" flows — kept here so the rule lives with the data.
 *
 * @param {string} userId
 * @returns {object} Mongo filter
 */
export const claimableBy = (userId) => ({
  isActive: true,
  $or: [{ assignedTo: null }, { assignedTo: userId }],
});

/** Roles allowed to read the lead pipeline. */
export const LEAD_READER_ROLES = Object.freeze([Roles.ADMIN, Roles.SALES_STAFF]);

export default {
  createPublicEnquiry,
  listLeads,
  getLeadById,
  addLeadNote,
  claimableBy,
  LEAD_READER_ROLES,
};
