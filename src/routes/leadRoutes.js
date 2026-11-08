/**
 * @file leadRoutes.js
 * @description Staff-facing lead pipeline (/api/v1/leads).
 *
 * The public POST /api/v1/leads lives in leadPublicRoutes.js so its rate
 * limiter does not throttle these reads.
 *
 * Ref: KAN-48
 */

import { Router } from 'express';
import Joi from 'joi';
import * as leadController from '../controllers/leadController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireRole } from '../middlewares/roleMiddleware.js';
import { validate, validateQuery } from '../middlewares/validateMiddleware.js';
import { LeadStage, Roles, PAGINATION } from '../constants/appConstants.js';

const router = Router();

const LEAD_READERS = [Roles.ADMIN, Roles.SALES_STAFF];

router.use(verifyToken, requireRole(...LEAD_READERS));

// ── DTO Schemas ────────────────────────────────────────────────────────────

const listLeadsQuerySchema = Joi.object({
  page:       Joi.number().integer().min(1).default(PAGINATION.DEFAULT_PAGE),
  limit:      Joi.number().integer().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
  stage:      Joi.string().valid(...Object.values(LeadStage)).optional(),
  assignedTo: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  search:     Joi.string().trim().max(100).optional(),
  hasVehicle: Joi.string().valid('true', 'false').optional(),
});

const addNoteSchema = Joi.object({
  note: Joi.string().trim().min(1).max(2000).required().messages({
    'string.empty':  'Nội dung ghi chú không được để trống.',
    'any.required':  'Vui lòng nhập nội dung ghi chú.',
  }),
});

/**
 * @route   GET /api/v1/leads
 * @access  ADMIN, SALES_STAFF
 */
router.get('/', validateQuery(listLeadsQuerySchema), leadController.listLeads);

/**
 * @route   GET /api/v1/leads/:id
 * @access  ADMIN, SALES_STAFF
 * @param   id - Lead ObjectId or leadCode (LD-NNNN)
 */
router.get('/:id', leadController.getLead);

/**
 * @route   POST /api/v1/leads/:id/notes
 * @access  ADMIN, SALES_STAFF
 */
router.post('/:id/notes', validate(addNoteSchema), leadController.addNote);

export default router;
