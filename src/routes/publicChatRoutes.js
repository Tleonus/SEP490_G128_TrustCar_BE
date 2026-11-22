/**
 * @file publicChatRoutes.js
 * @description Public AI Assistant Chatbot routes (/api/v1/public/chat).
 * Hardened for KAN-75: rejects `system` role in history, strips unknown keys,
 * and applies dedicated chat rate limiting.
 */

import { Router } from 'express';
import Joi from 'joi';
import * as chatController from '../controllers/chatController.js';
import { validate } from '../middlewares/validateMiddleware.js';
import { createPublicChatLimiter } from '../middlewares/rateLimiters.js';

const router = Router();
const publicChatLimiter = createPublicChatLimiter();

// KAN-75: strictly disallow `system` role in client-supplied conversation history.
const historyItemSchema = Joi.object({
  role: Joi.string().valid('user', 'assistant').required().messages({
    'any.only': 'history role must be either "user" or "assistant".',
  }),
  content: Joi.string().trim().max(2000).allow('').required(),
}).options({ allowUnknown: false });

export const sendChatMessageSchema = Joi.object({
  message: Joi.string().trim().min(1).max(1000).required().messages({
    'string.empty': 'message cannot be empty.',
    'any.required': 'message is required.',
  }),
  sessionId: Joi.string().trim().max(120).allow('', null).optional(),
  history: Joi.array().items(historyItemSchema).max(20).default([]),
  customerName: Joi.string().trim().max(150).allow('', null).optional(),
  customerPhone: Joi.string().trim().max(30).allow('', null).optional(),
}).options({ allowUnknown: false });

/**
 * @route   POST /api/v1/public/chat
 * @access  Public
 * @desc    Processes a customer message with Prompt Injection Guard & Query Whitelist,
 *          and returns grounded AI reply, vehicle cards, actions, and follow-ups.
 */
router.post('/', publicChatLimiter, validate(sendChatMessageSchema), chatController.sendMessage);

export default router;
