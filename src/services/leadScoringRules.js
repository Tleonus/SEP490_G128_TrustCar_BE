/**
 * @file leadScoringRules.js
 * @description KAN-97 — các hàm thuần tính điểm Lead, không chạm DB.
 *
 * Nguyên tắc:
 *  - Hàm thuần: cùng `(events, now, lead)` → cùng kết quả → cron chạy lại bao
 *    nhiêu lần cũng idempotent, không bao giờ trừ điểm lũy kế.
 *  - Decay theo tuổi *event* (`now - occurredAt`), không theo khoảng cách
 *    giữa hai lần cron.
 *  - Event ngoài cửa sổ 30 ngày bị bỏ, không đóng góp điểm (gián tiếp tạo decay
 *    tới 0 khi khách thôi tương tác).
 */

import {
  EVENT_WEIGHTS, GENERAL_EVENT_FACTOR, SCORE_MAX,
  DECAY_FACTOR_PER_WEEK, DECAY_WEEK_MS, EVENT_WINDOW_MS,
  HOT_THRESHOLD, WARM_THRESHOLD, SCORE_BAND,
} from '../constants/leadScoringConstants.js';

const EMPTY_FACTORS = Object.freeze({
  VIEW_CAR: 0, WISHLIST_ADD: 0, COMPARE_ADD: 0,
  CALCULATOR_USE: 0, FILTER_APPLY: 0, CONTACT_CLICK: 0,
});

/** Band của một điểm — ngưỡng HOT > 70, WARM 30..70, COLD < 30. */
export const bandOf = (score) => {
  if (score > HOT_THRESHOLD) return SCORE_BAND.HOT;
  if (score >= WARM_THRESHOLD) return SCORE_BAND.WARM;
  return SCORE_BAND.COLD;
};

/** Phần đóng góp (có decay) của một event. 0 khi ngoài cửa sổ hoặc event lạ. */
export const contributionOf = (event, now, { leadCarId = null } = {}) => {
  if (!event || !now) return 0;
  const weight = EVENT_WEIGHTS[event.eventType];
  if (typeof weight !== 'number') return 0;

  const occurredAt = event.occurredAt instanceof Date
    ? event.occurredAt
    : new Date(event.occurredAt);
  const age = now.getTime() - occurredAt.getTime();
  if (age < 0 || age > EVENT_WINDOW_MS) return 0;

  const weeksFloor = Math.floor(age / DECAY_WEEK_MS);
  const decay = Math.pow(DECAY_FACTOR_PER_WEEK, weeksFloor);

  // Event không gắn xe cụ thể: chỉ tính nửa trọng số cho mọi lead của khách.
  const isGeneral = event.carId == null;
  const factor = isGeneral ? GENERAL_EVENT_FACTOR : 1;

  // Nếu event có carId KHÁC xe của lead (và lead có gắn xe) thì không tính.
  // Ngoại trừ khi event được gắn thẳng vào leadId — đã lọc ở tầng gọi, không
  // phải việc của hàm thuần này.
  if (!isGeneral && leadCarId && String(event.carId) !== String(leadCarId)) return 0;

  return weight * decay * factor;
};

/**
 * Lọc list event thuộc về một lead theo quy tắc gộp của §5.2 trong SPEC.
 * @param {object[]} events - mọi event của customer trong cửa sổ, đã lean.
 * @param {object} lead     - lean lead { _id, car }
 * @returns {object[]}
 */
export const eventsForLead = (events, lead) => events.filter((event) => {
  if (!event) return false;
  // Ưu tiên tuyệt đối theo leadId: event gắn trực tiếp vào lead luôn được tính.
  if (event.leadId && String(event.leadId) === String(lead._id)) return true;
  if (event.leadId && String(event.leadId) !== String(lead._id)) return false;

  // Event không có leadId: dùng quy tắc theo carId.
  if (event.carId == null) return true;               // event chung, sẽ nhân 0.5
  if (lead.car == null) return true;                  // lead liên hệ chung → nhận hết event có xe
  return String(event.carId) === String(lead.car);    // cùng xe với lead
});

/**
 * Chấm điểm một lead từ danh sách event. Trả về `{ score, scoreBand,
 * factors, lastInteractionAt }`.
 */
export const scoreLead = (lead, events, now) => {
  const relevant = eventsForLead(events, lead);
  const factors = { ...EMPTY_FACTORS };
  let rawScore = 0;
  let lastInteractionAt = null;

  for (const event of relevant) {
    const contribution = contributionOf(event, now, { leadCarId: lead.car ?? null });
    if (contribution <= 0) continue;
    rawScore += contribution;
    factors[event.eventType] = (factors[event.eventType] || 0) + 1;
    const at = event.occurredAt instanceof Date ? event.occurredAt : new Date(event.occurredAt);
    if (!lastInteractionAt || at > lastInteractionAt) lastInteractionAt = at;
  }

  const score = Math.max(0, Math.min(SCORE_MAX, Math.round(rawScore)));
  return { score, scoreBand: bandOf(score), factors, lastInteractionAt };
};

export default { bandOf, contributionOf, eventsForLead, scoreLead };
