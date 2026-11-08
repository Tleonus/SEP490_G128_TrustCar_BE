/**
 * @file leadPublicRoutes.js
 * @description Public lead intake (/api/v1/leads).
 *
 * Split from leadRoutes.js on purpose: Express's app.use path matching means a
 * rate limiter mounted on `/api/v1/leads` would also throttle the staff
 * pipeline reads. Keeping the public POST in its own router lets the limiter
 * apply to exactly one endpoint.
 *
 * Ref: KAN-48
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import Joi from 'joi';
import * as leadController from '../controllers/leadController.js';
import { validate } from '../middlewares/validateMiddleware.js';
import { joiPhone } from '../utils/validators.js';

const router = Router();

/** Contact-form abuse guard: 5 enquiries per IP per 10 minutes. */
const enquiryLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max:      5,
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    success: false,
    message: 'Bạn đã gửi quá nhiều yêu cầu. Vui lòng thử lại sau 10 phút hoặc gọi hotline.',
    code:    'ENQUIRY_RATE_LIMIT',
  },
});

const submitEnquirySchema = Joi.object({
  full_name:       Joi.string().trim().min(2).max(150),
  fullName:        Joi.string().trim().min(2).max(150),
  phone_number:    joiPhone().required().messages({ 'any.required': 'Vui lòng nhập số điện thoại.' }),
  email:           Joi.string().trim().lowercase().email({ tlds: false }).max(254).allow('', null),
  request_content: Joi.string().trim().max(2000).allow('', null),
  message:         Joi.string().trim().max(2000).allow('', null),
  vehicleCode:     Joi.string().trim().max(64).allow('', null),
  page_path:       Joi.string().trim().max(300).allow('', null),
})
  // Reject unknown keys instead of letting the middleware silently strip them:
  // a typo'd `phone_numer` must fail loudly, not reach the service as undefined.
  .unknown(false)
  // At least one of each pair. Note that `.or(a, b)` means "if either is present,
  // both are required" — not "one of them" — so this has to be a custom rule.
  .custom((value, helpers) => {
    const hasName = Boolean(value.full_name || value.fullName);
    const hasBody = Boolean(value.request_content || value.message);
    if (hasName && hasBody) return value;
    return helpers.message('Vui lòng nhập {{#label}}.', {
      label: !hasName && !hasBody ? 'họ tên và nội dung yêu cầu' : (hasName ? 'nội dung yêu cầu' : 'họ tên'),
    });
  })
  .messages({
    'string.min':   '{{#label}} phải có ít nhất {{#limit}} ký tự.',
    'string.max':   '{{#label}} không được vượt quá {{#limit}} ký tự.',
    'string.email': 'Email không hợp lệ.',
    'object.unknown': 'Trường {{#label}} không hợp lệ.',
  });

/**
 * @route   POST /api/v1/leads
 * @access  Public
 * @desc    Accepts the public contact form and the car-detail consultation modal.
 *          Field names match the front-end payload exactly (snake_case).
 */
router.post(
  '/',
  enquiryLimiter,
  validate(submitEnquirySchema),
  (req, res, next) => {
    // Normalize the two accepted spellings into the shape leadService expects,
    // without changing the service contract.
    req.body = {
      fullName:  req.body.full_name || req.body.fullName,
      phone:     req.body.phone_number,
      email:     req.body.email || null,
      message:   req.body.request_content || req.body.message || null,
      vehicleCode: req.body.vehicleCode || null,
      pagePath:  req.body.page_path || null,
    };
    next();
  },
  leadController.submitEnquiry
);

export default router;
