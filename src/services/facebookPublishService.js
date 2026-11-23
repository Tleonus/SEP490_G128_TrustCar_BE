/**
 * @file facebookPublishService.js
 * @description Đăng bài (ảnh + caption) lên Facebook Page bằng Graph API (KAN-91).
 *
 * Luồng thật, không giả lập:
 *   1. Thiếu cấu hình Page ID / Page Access Token → 503 FACEBOOK_NOT_CONFIGURED kèm danh sách biến thiếu.
 *   2. Xe phải tồn tại, đang mở bán và có ảnh công khai (Cloudinary) để Graph API tải được.
 *   3. Gọi POST https://graph.facebook.com/{version}/{page-id}/photos với url + caption + published=true.
 *   4. Facebook từ chối → trả lỗi thật (token hết hạn, thiếu quyền, bị giới hạn tần suất…).
 *   5. Thành công → trả postId + link bài viết, ghi nhật ký hoạt động.
 *
 * Biến môi trường cần có (xem docs/kan-91-facebook-graph-publish.md):
 *   FACEBOOK_PAGE_ID, FACEBOOK_PAGE_ACCESS_TOKEN, [FACEBOOK_GRAPH_VERSION]
 */

import Car from '../models/Car.js';
import ActivityLog from '../models/ActivityLog.js';
import { ActivityEventType, CarStatus } from '../constants/appConstants.js';
import { AppError } from '../utils/apiResponse.js';
import { logger } from '../utils/logger.js';
import { resolveShareImage } from '../utils/shareFormat.js';
import { getFacebookConfig } from '../config/facebook.js';

const GRAPH_ORIGIN = 'https://graph.facebook.com';
const REQUEST_TIMEOUT_MS = 30000;
const CAPTION_MAX_LENGTH = 5000;

/** Chỉ xe đang bán mới được quảng cáo — khớp điều kiện của captionService. */
const SELLABLE = [CarStatus.AVAILABLE, CarStatus.APPROVED_CPO, CarStatus.RESERVED];

/**
 * Link công khai của bài viết.
 * Graph trả `post_id` dạng `{pageId}_{postId}`; tách ra để ghép permalink chuẩn.
 * @param {string} postId
 * @param {string} pageId
 * @returns {string|null}
 */
export const facebookPermalink = (postId, pageId) => {
  const raw = String(postId ?? '').trim();
  if (!raw) return null;
  const [pagePart, postPart] = raw.includes('_') ? raw.split('_') : [String(pageId ?? ''), raw];
  if (!pagePart || !postPart) return null;
  return `https://www.facebook.com/${pagePart}/posts/${postPart}`;
};

/**
 * Dịch lỗi Graph API thành AppError có mã ổn định cho Frontend.
 * Export để test được phần ánh xạ mã lỗi mà không cần gọi Facebook thật.
 * @param {object|null} payload body Facebook trả về
 */
export const mapGraphError = (payload) => {
  const error = payload?.error ?? {};
  const code = Number(error.code);
  const detail = String(error.message ?? '').trim();

  // 190: token hết hạn / bị thu hồi / sai.
  if (code === 190) {
    return new AppError(
      'Facebook rejected the Page access token (code 190). Generate a new long-lived Page token and update FACEBOOK_PAGE_ACCESS_TOKEN.',
      502,
      'FACEBOOK_TOKEN_INVALID',
    );
  }

  // 10/200/803: thiếu quyền, hoặc token là User token chứ không phải Page token.
  if (code === 10 || code === 200 || code === 803) {
    return new AppError(
      `The Page access token lacks permission to publish (code ${code}). Grant pages_manage_posts and use a Page token, not a User token.`,
      403,
      'FACEBOOK_PERMISSION_DENIED',
    );
  }

  // 100/33: Facebook không tải được object đích. Gặp khi FACEBOOK_PAGE_ID là ID tài khoản cá nhân
  // (Graph API không đăng được lên trang cá nhân, chỉ lên Page), ID sai, hoặc token của Page khác.
  if (code === 100 && Number(error.error_subcode) === 33) {
    return new AppError(
      'Facebook could not load FACEBOOK_PAGE_ID (code 100/33). It must be the numeric ID of a Page managed by this token; a personal profile, a wrong ID or another Page\'s token will fail.',
      502,
      'FACEBOOK_PAGE_NOT_ACCESSIBLE',
    );
  }

  // 4/17/32/613/80004: bị giới hạn tần suất.
  if ([4, 17, 32, 613, 80004].includes(code)) {
    return new AppError(
      'Facebook is rate limiting this Page. Please try again later.',
      429,
      'FACEBOOK_RATE_LIMIT',
    );
  }

  return new AppError(
    `Facebook rejected the post${detail ? `: ${detail}` : '.'}`,
    502,
    'FACEBOOK_PUBLISH_FAILED',
  );
};

/**
 * Đăng một bài ảnh + caption lên Page đã cấu hình.
 *
 * @param {object} params
 * @param {string} params.carId    ObjectId của xe
 * @param {string} params.caption  Nội dung bài đăng (đã gồm hashtag nếu có)
 * @param {string} [params.imageUrl] Ảnh muốn đăng; bỏ trống thì lấy ảnh chính của xe
 * @param {string} params.userId   Admin thực hiện (ghi nhật ký)
 * @param {string} [params.ipAddress]
 * @returns {Promise<{ postId: string, permalinkUrl: string|null, pageId: string, publishedAt: string }>}
 */
export const publishCarPost = async ({ carId, caption, imageUrl, userId, ipAddress }) => {
  const config = getFacebookConfig();
  if (!config.configured) {
    throw new AppError(
      `Facebook publishing is not configured. Missing environment variables: ${config.missing.join(', ')}.`,
      503,
      'FACEBOOK_NOT_CONFIGURED',
      config.missing.map((key) => ({ field: key, message: 'Chưa được đặt trong .env của Backend.' })),
    );
  }

  const text = String(caption ?? '').trim();
  if (!text || text.length > CAPTION_MAX_LENGTH) {
    throw new AppError(
      `Caption must be between 1 and ${CAPTION_MAX_LENGTH} characters.`,
      422,
      'VALIDATION_ERROR',
    );
  }

  const car = await Car.findOne({ _id: carId, isActive: true })
    .select('vehicleCode make model images socialImage status')
    .lean();
  if (!car) {
    throw new AppError('Vehicle not found.', 404, 'CAR_NOT_FOUND');
  }
  if (!SELLABLE.includes(car.status)) {
    throw new AppError(
      'This vehicle cannot be advertised in its current status.',
      422,
      'CAR_NOT_ADVERTISABLE',
    );
  }

  const photoUrl = String(imageUrl ?? '').trim() || resolveShareImage(car);
  if (!photoUrl) {
    throw new AppError(
      'This vehicle has no public image to publish. Add a primary image first.',
      422,
      'FACEBOOK_NO_IMAGE',
    );
  }

  const endpoint = `${GRAPH_ORIGIN}/${config.graphVersion}/${encodeURIComponent(config.pageId)}/photos`;
  const body = new URLSearchParams({
    url: photoUrl,
    caption: text,
    published: 'true',
    access_token: config.accessToken,
  });

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logger.error?.(`Facebook publish request failed: ${error.message}`);
    throw new AppError(
      'Could not reach Facebook from the server. Check the Backend network and try again.',
      502,
      'FACEBOOK_UNREACHABLE',
    );
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.error) {
    logger.warn?.(`Facebook publish rejected (HTTP ${response.status}): ${JSON.stringify(payload?.error ?? payload)}`);
    throw mapGraphError(payload);
  }

  const postId = String(payload?.post_id ?? payload?.id ?? '').trim();
  if (!postId) {
    throw new AppError(
      'Facebook accepted the request but returned no post id.',
      502,
      'FACEBOOK_PUBLISH_FAILED',
    );
  }

  const permalinkUrl = facebookPermalink(postId, config.pageId);

  // Ghi nhật ký không được làm hỏng kết quả: bài đã đăng thật trên Facebook.
  try {
    await ActivityLog.log({
      eventType: ActivityEventType.CAR_PUBLISHED_FACEBOOK,
      performedBy: userId,
      targetModel: 'Car',
      targetId: car._id,
      targetCode: car.vehicleCode,
      summary: `Vehicle ${car.vehicleCode} published to Facebook Page (post ${postId})`,
      ipAddress,
    });
  } catch (error) {
    logger.error?.(`Activity log for Facebook publish failed: ${error.message}`);
  }

  return {
    postId,
    permalinkUrl,
    pageId: config.pageId,
    publishedAt: new Date().toISOString(),
  };
};

export default { publishCarPost, facebookPermalink };
