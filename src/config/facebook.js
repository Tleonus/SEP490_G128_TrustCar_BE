/**
 * @file facebook.js
 * @description Cấu hình Facebook Graph API cho tính năng đăng bài tự động lên Page (KAN-91).
 *
 * Không đọc cứng giá trị nào: toàn bộ lấy từ biến môi trường để không lộ Page Access Token
 * trong mã nguồn. Khi thiếu cấu hình, service trả lỗi FACEBOOK_NOT_CONFIGURED kèm danh sách
 * biến còn thiếu — tuyệt đối không giả lập đăng bài thành công.
 */

/** Biến bắt buộc phải có để đăng bài được. */
export const FACEBOOK_ENV_KEYS = Object.freeze([
  'FACEBOOK_PAGE_ID',
  'FACEBOOK_PAGE_ACCESS_TOKEN',
]);

const DEFAULT_GRAPH_VERSION = 'v24.0';
const GRAPH_VERSION_PATTERN = /^v\d{1,3}\.\d{1,2}$/;

/**
 * Đọc cấu hình Facebook hiện tại.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ configured: boolean, pageId: string, accessToken: string, graphVersion: string, missing: string[] }}
 */
export function getFacebookConfig(env = process.env) {
  const read = (key) => String(env[key] ?? '').trim();

  const pageId = read('FACEBOOK_PAGE_ID');
  const accessToken = read('FACEBOOK_PAGE_ACCESS_TOKEN');
  const rawVersion = read('FACEBOOK_GRAPH_VERSION');
  const graphVersion = GRAPH_VERSION_PATTERN.test(rawVersion) ? rawVersion : DEFAULT_GRAPH_VERSION;

  const missing = [];
  if (!pageId) missing.push('FACEBOOK_PAGE_ID');
  if (!accessToken) missing.push('FACEBOOK_PAGE_ACCESS_TOKEN');

  return {
    configured: missing.length === 0,
    pageId,
    accessToken,
    graphVersion,
    missing,
  };
}

export default { FACEBOOK_ENV_KEYS, getFacebookConfig };
