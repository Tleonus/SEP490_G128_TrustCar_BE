/**
 * @file leadScoringConstants.js
 * @description KAN-97 — trọng số, ngưỡng và cửa sổ decay cho Lead Scoring.
 *
 * Mọi chỉnh số (trọng số, ngưỡng band, cửa sổ decay) đổi ở đây là đủ: scoring
 * rules thuần sẽ đọc lại qua import, cron và endpoint `/hot` không cần sửa.
 */

/** Whitelist eventType nhận từ POST /api/v1/track. */
export const TRACKABLE_EVENT_TYPES = Object.freeze([
  'VIEW_CAR', 'WISHLIST_ADD', 'FILTER_APPLY', 'CONTACT_CLICK', 'COMPARE_ADD', 'CALCULATOR_USE',
]);

/**
 * Event bắt buộc có carId — gắn với một xe cụ thể. BE 422 nếu thiếu `carId`,
 * còn FILTER_APPLY / CALCULATOR_USE / CONTACT_CLICK có thể xảy ra ngoài trang xe.
 */
export const CAR_REQUIRED_EVENT_TYPES = Object.freeze(['VIEW_CAR', 'WISHLIST_ADD', 'COMPARE_ADD']);

/** Trọng số gốc của từng loại tương tác (chưa decay). */
export const EVENT_WEIGHTS = Object.freeze({
  VIEW_CAR:       10,
  WISHLIST_ADD:   25,
  COMPARE_ADD:    12,
  CALCULATOR_USE: 10,
  FILTER_APPLY:    3,
  CONTACT_CLICK:  20,
});

/**
 * Event không gắn xe (FILTER_APPLY, CALCULATOR_USE, CONTACT_CLICK không có carId)
 * chỉ tính nửa trọng số cho từng lead vì không khớp một xe cụ thể.
 */
export const GENERAL_EVENT_FACTOR = 0.5;

export const SCORE_MAX = 100;

/** Decay: mỗi 7 ngày tuổi, hệ số còn 90%. */
export const DECAY_FACTOR_PER_WEEK = 0.9;
export const DECAY_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Event cũ hơn mốc này bị bỏ qua khi chấm. */
export const EVENT_WINDOW_DAYS = 30;
export const EVENT_WINDOW_MS = EVENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export const SCORE_BAND = Object.freeze({ HOT: 'HOT', WARM: 'WARM', COLD: 'COLD' });

/** HOT khi score > 70; WARM khi 30 ≤ score ≤ 70; COLD khi < 30. */
export const HOT_THRESHOLD = 70;
export const WARM_THRESHOLD = 30;

/** Stage còn được chấm điểm — lead WON/LOST đã đóng, giữ nguyên điểm cũ. */
export const SCORABLE_STAGES = Object.freeze(['NEW', 'CONTACTED', 'QUALIFIED', 'NEGOTIATING']);

/** Cron mặc định 5 phút; override bằng env LEAD_SCORING_INTERVAL_MS. */
export const DEFAULT_SCORING_INTERVAL_MS = 5 * 60 * 1000;

export const HOT_LEADS_MAX_LIMIT = 100;

export default {
  TRACKABLE_EVENT_TYPES, CAR_REQUIRED_EVENT_TYPES, EVENT_WEIGHTS, GENERAL_EVENT_FACTOR,
  SCORE_MAX, DECAY_FACTOR_PER_WEEK, DECAY_WEEK_MS, EVENT_WINDOW_DAYS, EVENT_WINDOW_MS,
  SCORE_BAND, HOT_THRESHOLD, WARM_THRESHOLD, SCORABLE_STAGES,
  DEFAULT_SCORING_INTERVAL_MS, HOT_LEADS_MAX_LIMIT,
};
