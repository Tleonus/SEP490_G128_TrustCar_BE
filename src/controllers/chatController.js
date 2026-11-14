/**
 * @file chatController.js
 * @description Public AI Assistant Chatbot controller (/api/v1/public/chat).
 * Delegates all business logic to `chatService.js`.
 */

import * as chatService from '../services/chatService.js';
import { sendSuccess } from '../utils/apiResponse.js';

/**
 * @route   POST /api/v1/public/chat
 * @access  Public (no authentication required)
 * @body    { message: string, sessionId?: string, history?: Array, customerName?: string, customerPhone?: string }
 */
export const sendMessage = async (req, res, next) => {
  try {
    const result = await chatService.processPublicChatMessage(req.body, {
      ipAddress: req.ip || null,
      userAgent: req.get('user-agent') || null,
    });

    return sendSuccess(res, 200, 'Chat response generated successfully.', result);
  } catch (error) {
    return next(error);
  }
};

export default { sendMessage };

