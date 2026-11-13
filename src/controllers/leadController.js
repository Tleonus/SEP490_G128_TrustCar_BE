/**
 * @file leadController.js
 * @description Lead (CRM) controller. Contains no business logic — every branch
 * lives in leadService.js.
 *
 * Routes handled (KAN-48):
 * - POST /api/v1/leads                     → submitEnquiry   (public)
 * - GET  /api/v1/leads                     → listLeads       (staff)
 * - GET  /api/v1/leads/:id                 → getLead         (staff)
 * - POST /api/v1/leads/:id/notes           → addNote         (staff)
 */

import * as leadService from '../services/leadService.js';
import { sendSuccess, sendPaginated } from '../utils/apiResponse.js';

/**
 * @route   POST /api/v1/leads
 * @access  Public (no auth required)
 * @body    { full_name, phone_number, email?, request_content?, vehicleCode?, page_path? }
 * @desc    Records a contact-form or "request a consultation" enquiry as a Lead.
 *          Returns the generated lead code so the visitor can quote it.
 */
export const submitEnquiry = async (req, res, next) => {
  try {
    const result = await leadService.createPublicEnquiry(req.body, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return sendSuccess(
      res,
      201,
      `Yêu cầu của bạn đã được ghi nhận. Mã yêu cầu: ${result.leadCode}. TrustCar sẽ liên hệ trong thời gian sớm nhất.`,
      result
    );
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/v1/leads
 * @access  ADMIN, SALES_STAFF
 * @query   { page, limit, stage, assignedTo, search, hasVehicle }
 * @desc    Paginated lead pipeline for the sales team.
 */
export const listLeads = async (req, res, next) => {
  try {
    const { items, pagination } = await leadService.listLeads(req.query);
    return sendPaginated(res, 'Leads retrieved successfully.', items, pagination);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/v1/leads/:id
 * @access  ADMIN, SALES_STAFF
 * @param   id - Lead ObjectId or leadCode (LD-NNNN)
 */
export const getLead = async (req, res, next) => {
  try {
    const lead = await leadService.getLeadById(req.params.id);
    return sendSuccess(res, 200, 'Lead retrieved successfully.', lead);
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/v1/leads/:id/notes
 * @access  ADMIN, SALES_STAFF
 * @body    { note }
 * @desc    Appends a note to the lead timeline (append-only, GBR-18).
 */
export const addNote = async (req, res, next) => {
  try {
    const lead = await leadService.addLeadNote(req.params.id, {
      note:        req.body.note,
      performedBy: req.userId,
      ipAddress:   req.ip,
      userAgent:   req.get('user-agent'),
    });

    return sendSuccess(res, 201, 'Note added successfully.', lead);
  } catch (error) {
    next(error);
  }
};

export default { submitEnquiry, listLeads, getLead, addNote };
