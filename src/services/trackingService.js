/**
 * @file trackingService.js
 * @description KAN-97 — tiếp nhận event tương tác từ web khách.
 *
 * Idempotent dùng lại session khi client truyền `sessionId` đã tồn tại; lần
 * đầu BE sinh VisitorSession mới và trả về cho client lưu. Khi client đăng
 * nhập giữa phiên, lần request đầu tiên sau đó sẽ gán `customerId` lên
 * session hiện có (bắc cầu lịch sử tương tác ẩn danh với tài khoản).
 *
 * Tuyệt đối không tạo InteractionEvent gắn carId không tồn tại: validate ở
 * tầng service để endpoint rẻ với spam.
 */

import mongoose from 'mongoose';
import Car from '../models/Car.js';
import VisitorSession from '../models/visitor-session.model.js';
import InteractionEvent from '../models/interaction-event.model.js';
import { AppError } from '../utils/apiResponse.js';

const isValidId = (value) => typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);

/**
 * @param {object} params
 * @param {string|null} params.sessionId   - client gửi lên; null → tạo mới
 * @param {string|null} params.customerId  - từ req.user.customer nếu có token
 * @param {string}      params.eventType
 * @param {string|null} params.carId
 * @param {object|null} [params.metadata]
 * @param {Date}        [params.now]
 * @returns {Promise<{ sessionId: string, eventId: string }>}
 */
export const recordInteraction = async ({
  sessionId, customerId = null, eventType, carId = null, metadata = null, now = new Date(),
}) => {
  if (carId) {
    const exists = await Car.exists({ _id: carId });
    if (!exists) throw new AppError('Car not found.', 404, 'CAR_NOT_FOUND');
  }

  let session = null;
  if (isValidId(sessionId)) {
    session = await VisitorSession.findById(sessionId);
  }
  if (!session) {
    session = await VisitorSession.create({
      customerId: customerId || null,
      startedAt: now,
      lastSeenAt: now,
    });
  } else {
    const patch = { lastSeenAt: now };
    // Khách vừa đăng nhập giữa phiên: ghi gắn session với customer.
    if (customerId && !session.customerId) patch.customerId = customerId;
    if (patch.customerId || true) {
      await VisitorSession.updateOne({ _id: session._id }, { $set: patch });
    }
  }

  const event = await InteractionEvent.create({
    sessionId: session._id,
    carId: carId || null,
    eventType,
    occurredAt: now,
    metadata: metadata || null,
  });

  return { sessionId: String(session._id), eventId: String(event._id) };
};

export default { recordInteraction };
