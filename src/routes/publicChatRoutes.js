/**
 * @file publicChatRoutes.js
 * @description Public AI Assistant Chatbot routes (/api/v1/public/chat).
 */

import { Router } from 'express';
import Joi from 'joi';
import * as chatController from '../controllers/chatController.js';
import { validate } from '../middlewares/validateMiddleware.js';

const router = Router();

const historyItemSchema = Joi.object({
  role: Joi.string().valid('user', 'assistant', 'system').required(),
  content: Joi.string().trim().max(2000).allow('').required(),
});

export const sendChatMessageSchema = Joi.object({
  message: Joi.string().trim().min(1).max(1000).required().messages({
    'string.empty': 'message cannot be empty.',
    'any.required': 'message is required.',
  }),
  sessionId: Joi.string().trim().max(120).allow('', null).optional(),
  history: Joi.array().items(historyItemSchema).max(20).default([]),
  customerName: Joi.string().trim().max(150).allow('', null).optional(),
  customerPhone: Joi.string().trim().max(30).allow('', null).optional(),
});

/**
 * @route   POST /api/v1/public/chat
 * @access  Public
 * @desc    Processes a customer message and returns grounded AI reply, vehicle cards, actions, and follow-ups.
 */
router.post('/', validate(sendChatMessageSchema), chatController.sendMessage);

export default router;

