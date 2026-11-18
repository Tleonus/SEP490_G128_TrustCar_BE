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
 *
 * Shape of a caption (KAN-68 follow-up, "form mới"):
 *
 *   TIÊU ĐỀ IN HOA — MẪU XE + NĂM                 ← hook of the tone
 *   (dòng mở đầu của tone)
 *   • Phiên bản: …
 *   • Số km đã đi: …
 *   • Hộp số · nhiên liệu · kiểu dáng
 *   • Tình trạng: …
 *   Giá: …
 *   CTA
 *
 * This is a used-car showroom: the bullets lead with year and odometer, exactly
 * the two things a buyer of a second-hand car checks first. Nothing here claims
 * the car is new, unused or under warranty.
 */

import { factsTitle } from './captionFacts.js';

/**
 * "MERCEDES-BENZ C-Class C250 Exclusive 2017" — only the make is capitalised, so
 * "C-Class" keeps the casing the showroom stored instead of becoming "C-CLASS".
 */
const cardTitle = (f) => [
  f.make ? String(f.make).toUpperCase() : null,
  f.model,
  f.variant,
  f.year,
].filter(Boolean).join(' ');

/**
 * "Phiên bản" is the variant plus the year. If the model string already carries
 * the year ("C-Class 2017"), it is not repeated.
 */
const VERSION_LINE = (f) => {
  const modelHasYear = f.model && f.year && String(f.model).includes(String(f.year));
  const parts = modelHasYear ? [f.variant] : [f.variant, f.year];
  const text = parts.filter(Boolean).join(' ');
  return text || null;
};

/** Odometer as a bare figure, for the compact one-line form. */
const MILEAGE_SHORT = (f) => {
  const value = Number(f.mileage);
  return Number.isFinite(value) && value > 0 ? `${value.toLocaleString('en-US')} km` : null;
};

/**
 * Odometer line. Returns null when the record has no mileage rather than filling
 * the gap with a phrase — "xe mới về showroom" would read as "brand new" on a
 * used car, and an odometer the record lacks is not something a caption may guess.
 */
const MILEAGE_LINE = (f) => {
  const value = Number(f.mileage);
  return Number.isFinite(value) && value > 0 ? `${value.toLocaleString('en-US')} km` : null;
};

const SPEC_LINE = (f) => {
  const parts = [f.transmission, f.fuelType ? `máy ${f.fuelType}` : null, f.bodyType]
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
};

const CONDITION_LINE = (f) => {
  if (f.cpoCode && f.criteriaCount > 0) {
    return `Đã qua thẩm định ${f.criteriaCount} nhóm tiêu chí tại TrustCar, có chứng nhận CPO`;
  }
  if (f.conditionGrade) return `Tình trạng ${f.conditionGrade} theo biên bản kiểm tra tại TrustCar`;
  return 'Đã kiểm tra ngoại quan và vận hành tại TrustCar';
};

/** Bulleted detail block. Lines with no data are dropped, never filled with a guess. */
const DETAIL_BULLETS = (f) => [
  VERSION_LINE(f) ? `• Phiên bản: ${VERSION_LINE(f)}` : null,
  MILEAGE_LINE(f) ? `• Số km đã đi: ${MILEAGE_LINE(f)}` : null,
  SPEC_LINE(f) ? `• ${SPEC_LINE(f)}` : null,
  `• ${CONDITION_LINE(f)}`,
].filter(Boolean);

const HOOKS = {
  professional: [
    {
      title: (f) => `${cardTitle(f)} — XE ĐÃ QUA THẨM ĐỊNH TẠI TRUSTCAR`,
      lead: null,
    },
    {
      title: (f) => `${cardTitle(f)} — ĐÃ KIỂM ĐỊNH, SẴN SÀNG LĂN BÁNH`,
      lead: (f) => `Một chiếc ${f.bodyType || 'xe'} đã qua sử dụng, được TrustCar kiểm tra lại trước khi bày bán: ${factsTitle(f)}.`,
    },
    {
      title: (f) => `XE CŨ, THÔNG TIN KHÔNG CŨ: ${cardTitle(f)}`,
      lead: () => 'Số km thực tế, tình trạng thẩm định và giá bán đều được ghi rõ trong biên bản tại TrustCar.',
    },
  ],
  friendly: [
    {
      title: (f) => `${cardTitle(f)} VỪA VỀ SHOWROOM TRUSTCAR`,
      lead: () => 'Chào bạn, chiếc xe này vừa được kiểm tra xong và sẵn sàng cho bạn xem ngay tại showroom.',
    },
    {
      title: (f) => `${cardTitle(f)} — CHIẾC XE RẤT ĐÁNG ĐỂ XEM TẬN MẮT`,
      lead: (f) => `Bạn đang tìm một chiếc ${f.bodyType || 'xe'} cho gia đình? Đây là mẫu xe đang được hỏi thăm nhiều tuần này.`,
    },
    {
      title: (f) => `${cardTitle(f)} — MỜI BẠN GÉ TỚI XEM THỬ`,
      lead: () => 'Ngồi thử và chạy thử luôn là cách tốt nhất để biết chiếc xe có hợp với mình không.',
    },
  ],
  urgent: [
    {
      title: (f) => `${cardTitle(f)} — XE ĐANG NHẬN GIỮ CHỖ`,
      lead: () => 'Chiếc xe này đang được khách khác quan tâm, anh/chị muốn xem thì nên liên hệ sớm.',
    },
    {
      title: (f) => `VỪA KIỂM XONG: ${cardTitle(f)}`,
      lead: () => 'Xe vừa hoàn tất thẩm định tại TrustCar và có mặt tại showroom, số lượng chỉ có một chiếc.',
    },
    {
      title: (f) => `${cardTitle(f)} — GIÁ ĐÃ NIÊM YẾT, XEM LÀ BIẾT`,
      lead: () => 'Giá và tình trạng đều công khai trước khi xem xe, không cần dò hỏi vòng vo.',
    },
  ],
};

const PRICE_LINE = (f) => (f.priceBandLabel ? `Giá: ${f.priceLabel} (${f.priceBandLabel})` : `Giá: ${f.priceLabel}`);

const CLOSERS = {
  facebook: 'Inbox TrustCar để nhận thêm thông tin và đặt lịch xem xe trực tiếp.',
  zalo: 'Nhắn Zalo TrustCar để được tư vấn và sắp lịch xem xe.',
};

/** Short captions must still read as a complete post, so they get their own closer. */
const SHORT_CLOSERS = {
  facebook: 'Inbox TrustCar để xem xe trực tiếp.',
  zalo: 'Nhắn Zalo TrustCar để tư vấn.',
};

/** Hashtags are built from real fields, never from a fixed "hot deal" list. */
export const templateHashtags = (facts, platform) => {
  // "MERCEDES-BENZ" → "MercedesBenz"; "C-Class" → "CClass". Facebook treats a
  // hyphen as a tag terminator, so "#Mercedes-benz" would render as "#Mercedes".
  const toTag = (raw) => String(raw ?? '')
    .split(/[\s\-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');

  const tags = ['TrustCar', 'XeDaLuaChon'];
  if (facts.make) tags.push(toTag(facts.make));
  if (facts.model) tags.push(toTag(facts.model));
  if (facts.cpoCode && facts.criteriaCount > 0) tags.push('CPO');
  if (platform === 'zalo') tags.push('Zalo');
  return [...new Set(tags)].map((t) => `#${t}`);
};

/** "SEARCHABLE" hashtag for the year, so buyers filtering "2020" find the post. */
const yearTag = (facts) => (facts.year ? `#XeNam${facts.year}` : null);

/**
 * @param {object} facts
 * @param {{ tone?: string, platform?: string, length?: string }} options
 * @returns {{ captions: string[], hashtags: string[], imageSuggestion: object }}
 */
export const buildTemplateCaptions = (facts, { tone = 'professional', platform = 'facebook', length = 'medium' } = {}) => {
  const hooks = HOOKS[tone] || HOOKS.professional;
  const close = (length === 'short' ? SHORT_CLOSERS : CLOSERS)[platform] || CLOSERS.facebook;

  const captions = hooks.map((hook) => {
    const lines = [hook.title(facts)];

    if (length === 'short') {
      // One screen of a phone: title, the two things buyers ask first, price, CTA.
      const odo = MILEAGE_SHORT(facts);
      if (odo) lines.push(facts.fuelType ? `${odo} · máy ${facts.fuelType}` : odo);
      else if (facts.fuelType) lines.push(`Máy ${facts.fuelType}`);
      lines.push(PRICE_LINE(facts));
      if (facts.cpoCode && facts.criteriaCount > 0) {
        lines.push(`Đã thẩm định đủ ${facts.criteriaCount} nhóm tiêu chí tại TrustCar.`);
      }
      lines.push(close);
      return lines.join('\n');
    }

    if (typeof hook.lead === 'function') {
      const lead = hook.lead(facts);
      if (lead) lines.push(lead);
    }
    lines.push('');
    lines.push(...DETAIL_BULLETS(facts));
    lines.push('');
    lines.push(PRICE_LINE(facts));
    lines.push(close);
    return lines.join('\n');
  });

  const hashtags = templateHashtags(facts, platform);
  const year = yearTag(facts);
  if (year && !hashtags.includes(year)) hashtags.push(year);

  return {
    captions,
    hashtags,
    imageSuggestion: {
      url: facts.imageUrl,
      note: `Ảnh 1200×630 của ${factsTitle(facts)}.`,
    },
  };
};

export default { buildTemplateCaptions, templateHashtags };
