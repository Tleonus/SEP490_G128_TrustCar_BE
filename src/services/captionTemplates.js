/**
 * @file captionTemplates.js
 * @description Deterministic caption options built from the fact sheet alone.
 *
 * Two jobs. When no LLM key is configured (local development, CI, and the
 * default in production until ops sets CAPTION_LLM_API_KEY) these are the
 * captions the endpoint returns. When an LLM is configured but its output fails
 * the grounding check, these top the list back up to three options rather than
 * returning a short list to the user.
 *
 * Every placeholder here is a field of CaptionFacts, so the output is grounded
 * by construction — the numbers are literally the stored ones.
 */

import { factsTitle } from './captionFacts.js';

const HOOKS = {
  professional: [
    (f) => `${factsTitle(f)} — xe đã qua thẩm định ${f.criteriaCount} nhóm tiêu chí tại TrustCar.`,
    (f) => `Cần một chiếc xe đáng tin? ${factsTitle(f)} đang có tại TrustCar.`,
    (f) => `${factsTitle(f)}: thông tin rõ ràng, tình trạng đã kiểm định.`,
  ],
  friendly: [
    (f) => `Chào bạn, ${factsTitle(f)} vừa về showroom TrustCar đó!`,
    (f) => `${factsTitle(f)} — chiếc xe đang được nhiều khách hỏi thăm nhất tuần này.`,
    (f) => `Bạn đang tìm xe gia đình? Ghé xem ${factsTitle(f)} nhé.`,
  ],
  urgent: [
    (f) => `Chỉ còn một chiếc ${factsTitle(f)} tại TrustCar — ai nhanh tay người đó được.`,
    (f) => `${factsTitle(f)} đang được giữ chỗ, anh/chị quan tâm hãy liên hệ ngay.`,
    (f) => `Xe về sáng nay: ${factsTitle(f)}. Số lượng có hạn.`,
  ],
};

const DETAIL_LINE = (f) => {
  const parts = [];
  if (f.mileage !== null && f.mileage !== undefined) parts.push(`${f.mileage.toLocaleString('en-US')} km`);
  if (f.transmission) parts.push(f.transmission);
  if (f.fuelType) parts.push(`máy ${f.fuelType}`);
  return parts.join(' · ');
};

const PRICE_LINE = (f) => `Giá: ${f.priceLabel}`;

const CLOSERS = {
  facebook: 'Inbox TrustCar để xem xe trực tiếp.',
  zalo: 'Nhắn Zalo TrustCar để được tư vấn.',
};

/** Hashtags are built from real fields, never from a fixed "hot deal" list. */
export const templateHashtags = (facts, platform) => {
  const tags = ['TrustCar', 'XeDaLuaChon'];
  if (facts.make) tags.push(facts.make.charAt(0) + facts.make.slice(1).toLowerCase());
  if (facts.model) tags.push(facts.model.replace(/\s+/g, ''));
  if (facts.cpoCode && facts.criteriaCount > 0) tags.push('CPO');
  if (platform === 'zalo') tags.push('Zalo');
  return [...new Set(tags)].map((t) => `#${t}`);
};

/**
 * @param {object} facts
 * @param {{ tone?: string, platform?: string, length?: string }} options
 * @returns {{ captions: string[], hashtags: string[], imageSuggestion: object }}
 */
export const buildTemplateCaptions = (facts, { tone = 'professional', platform = 'facebook', length = 'medium' } = {}) => {
  const hooks = HOOKS[tone] || HOOKS.professional;
  const detail = DETAIL_LINE(facts);
  const close = CLOSERS[platform] || CLOSERS.facebook;

  const captions = hooks.map((hook) => {
    const lines = [hook(facts)];
    if (length !== 'short') {
      if (detail) lines.push(detail);
      lines.push(PRICE_LINE(facts));
      if (facts.cpoCode && facts.criteriaCount > 0) {
        lines.push(`Chứng nhận CPO ${facts.cpoCode} — đạt ${facts.criteriaCount}/${facts.criteriaCount} nhóm tiêu chí.`);
      }
    } else {
      lines.push(PRICE_LINE(facts));
    }
    if (length !== 'short') lines.push(close);
    return lines.join('\n');
  });

  return {
    captions,
    hashtags: templateHashtags(facts, platform),
    imageSuggestion: {
      url: facts.imageUrl,
      note: `Ảnh 1200×630 của ${factsTitle(facts)}.`,
    },
  };
};

export default { buildTemplateCaptions, templateHashtags };
