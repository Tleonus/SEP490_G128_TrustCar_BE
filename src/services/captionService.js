/**
 * @file captionService.js
 * @description Facebook/Zalo caption suggestions for a vehicle (KAN-68).
 *
 * Flow: load the car → answer from cache when the facts are unchanged → otherwise
 * ask the model with a prompt built only from the fact sheet → drop every option
 * that states a number the car does not have → top the list back up to three with
 * template captions → cache the result.
 *
 * The order matters. Grounding runs before the top-up, so a hallucinated option
 * can never reach the client even when it is the only one the model produced.
 *
 * Cache: `content_items` with type FB_CAPTION and linkUrl = carId. The title
 * carries the options that produced it plus a fingerprint of the facts, so
 * editing the car's price or mileage regenerates instead of serving stale copy.
 *
 * Deliberately does NOT import enums from models/extendedEnums.js — that set
 * disagrees with constants/appConstants.js (PETROL vs GASOLINE) and mixing them
 * would silently break the label maps.
 */

import crypto from 'crypto';
import Car from '../models/Car.js';
import ContentItem from '../models/content-item.model.js';
import { AppError } from '../utils/apiResponse.js';
import { CarStatus } from '../constants/appConstants.js';
import { logger } from '../utils/logger.js';
import { buildCaptionFacts, factsTitle } from './captionFacts.js';
import { allowedNumbers, filterGrounded } from './captionGuard.js';
import { buildTemplateCaptions, templateHashtags } from './captionTemplates.js';
import * as llm from './captionLlmClient.js';

export const Tones = Object.freeze({ PROFESSIONAL: 'professional', FRIENDLY: 'friendly', URGENT: 'urgent' });
export const Platforms = Object.freeze({ FACEBOOK: 'facebook', ZALO: 'zalo' });
export const Lengths = Object.freeze({ SHORT: 'short', MEDIUM: 'medium' });

export const CAPTION_TYPE = 'FB_CAPTION';
export const OPTION_COUNT = 3;

/** The car has to exist and be sellable before anyone writes a post about it. */
const SELLABLE = [CarStatus.AVAILABLE, CarStatus.APPROVED_CPO, CarStatus.RESERVED];

/** Fingerprint of everything the prompt can see (imageUrl excluded: it is cosmetic). */
const factsFingerprint = (facts) => crypto
  .createHash('sha256')
  .update(JSON.stringify([
    facts.make, facts.model, facts.variant, facts.year, facts.mileage, facts.price,
    facts.transmission, facts.fuelType, facts.bodyType, facts.conditionGrade,
    facts.cpoCode, facts.criteriaCount,
  ]))
  .digest('hex')
  .slice(0, 16);

const cacheTitle = (facts, { tone, platform, length }) =>
  `${tone}|${platform}|${length}|${factsFingerprint(facts)}`;

const SYSTEM_PROMPT = [
  'Bạn là nhân viên marketing của TrustCar, showroom xe đã qua sử dụng có kiểm định (CPO).',
  'Viết caption đăng mạng xã hội bằng tiếng Việt, tự nhiên, không sáo rỗng.',
  '',
  'QUY TẮC BẮT BUỘC:',
  '1. Chỉ được dùng đúng các thông tin trong phần THÔNG TIN XE bên dưới.',
  '2. KHÔNG được viết bất kỳ con số nào không có trong THÔNG TIN XE — không đoán dung tích',
  '   động cơ, số chỗ, số túi khí, mức tiêu hao nhiên liệu, năm sản xuất khác, mức giảm giá,',
  '   số lượng xe còn lại, hay thời hạn khuyến mãi.',
  '3. Không hứa hẹn bảo hành, không cam kết pháp lý, không nói xe "mới 100%".',
  '4. Trả về JSON đúng một object, không kèm chữ nào khác, dạng:',
  '   {"captions": ["...", "...", "..."], "hashtags": ["#..."], "imageSuggestion": "..."}',
].join('\n');

const userPrompt = (facts, { tone, platform, length }) => {
  const lines = [
    'THÔNG TIN XE (đây là toàn bộ dữ liệu bạn có):',
    `- Hãng: ${facts.make}`,
    `- Dòng xe: ${facts.model}`,
    facts.variant ? `- Phiên bản: ${facts.variant}` : null,
    `- Năm sản xuất: ${facts.year}`,
    `- Số km đã đi: ${facts.mileage}`,
    facts.transmission ? `- Hộp số: ${facts.transmission}` : null,
    facts.fuelType ? `- Nhiên liệu: ${facts.fuelType}` : null,
    facts.bodyType ? `- Kiểu dáng: ${facts.bodyType}` : null,
    `- Giá: ${facts.priceLabel}`,
    facts.cpoCode ? `- Mã chứng nhận CPO: ${facts.cpoCode}` : null,
    facts.criteriaCount ? `- Đã đạt ${facts.criteriaCount}/${facts.criteriaCount} nhóm tiêu chí kiểm định` : null,
    '',
    `Giọng điệu: ${tone}. Nền tảng: ${platform}. Độ dài: ${length === 'short' ? 'ngắn (1-2 câu)' : 'trung bình (3-5 câu)'}.`,
    `Viết ${OPTION_COUNT} phương án khác nhau, mỗi phương án một hướng tiếp cận.`,
  ];
  return lines.filter((l) => l !== null).join('\n');
};

/** Lenient parse: the model was asked for bare JSON, but fences happen. */
const parseModelReply = (text) => {
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Caption LLM reply contained no JSON object.');
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  return {
    captions: Array.isArray(parsed.captions) ? parsed.captions.map(String) : [],
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.map(String) : [],
    imageSuggestion: typeof parsed.imageSuggestion === 'string' ? parsed.imageSuggestion : null,
  };
};

const readCache = async (title) => {
  try {
    const item = await ContentItem.findOne({ type: CAPTION_TYPE, title }).lean();
    if (!item?.body) return null;
    const payload = JSON.parse(item.body);
    return Array.isArray(payload?.captions) && payload.captions.length ? payload : null;
  } catch {
    return null; // a corrupt cache row must never fail the request
  }
};

const writeCache = async (title, payload, authorUserId) => {
  try {
    await ContentItem.create({
      authorUserId,
      type: CAPTION_TYPE,
      title,
      body: JSON.stringify(payload),
      linkUrl: payload.carId,
      status: 'DRAFT',
    });
  } catch (error) {
    logger.error?.(`Caption cache write failed: ${error.message}`);
  }
};

/**
 * @param {object} params
 * @param {string} params.carId
 * @param {string} [params.tone]
 * @param {string} [params.platform]
 * @param {string} [params.length]
 * @param {string} params.userId - caller, stored as the cache row author
 * @returns {Promise<{ captions: string[], hashtags: string[], imageSuggestion: object, cached: boolean, source: 'llm'|'template'|'mixed', droppedCount: number }>}
 */
export const generateCaptions = async ({ carId, tone = Tones.PROFESSIONAL, platform = Platforms.FACEBOOK, length = Lengths.MEDIUM, userId }) => {
  const car = await Car.findById(carId)
    .select('make model variant year mileage price transmission fuelType bodyType conditionGrade cpoCertificateId images socialImage status isActive')
    .lean();

  if (!car || car.isActive === false) {
    throw new AppError('Vehicle not found.', 404, 'CAR_NOT_FOUND');
  }
  if (!SELLABLE.includes(car.status)) {
    throw new AppError('This vehicle cannot be advertised in its current status.', 422, 'CAR_NOT_ADVERTISABLE');
  }

  const facts = buildCaptionFacts(car);
  const options = { tone, platform, length };
  const title = cacheTitle(facts, options);

  const cached = await readCache(title);
  if (cached) {
    return { ...cached, cached: true };
  }

  const allowed = allowedNumbers(facts);
  const template = buildTemplateCaptions(facts, options);

  let captions = [];
  let hashtags = [];
  let imageSuggestion = null;
  let source = 'template';
  let droppedCount = 0;

  if (llm.isConfigured()) {
    try {
      const reply = await llm.complete({ system: SYSTEM_PROMPT, user: userPrompt(facts, options) });
      const parsed = parseModelReply(reply);
      const { kept, dropped } = filterGrounded(parsed.captions, allowed);
      captions = kept;
      droppedCount = dropped.length;
      hashtags = parsed.hashtags;
      imageSuggestion = parsed.imageSuggestion;
      source = kept.length ? 'llm' : 'template';
    } catch (error) {
      logger.error?.(`Caption LLM unavailable, using templates: ${error.message}`);
    }
  }

  // Top up to three options from the templates, which are grounded by construction.
  if (captions.length < OPTION_COUNT) {
    const filler = template.captions.filter((c) => !captions.includes(c));
    captions = [...captions, ...filler].slice(0, OPTION_COUNT);
    if (source === 'llm') source = 'mixed';
  }

  // Hashtags are also model output, so the same rule applies: no invented digits.
  const safeTags = hashtags.filter((tag) => !/\d/.test(tag) || allowed.has(tag.replace(/\D/g, '')));
  if (safeTags.length < 2) {
    hashtags = templateHashtags(facts, platform);
  }

  const payload = {
    captions,
    hashtags,
    imageSuggestion: {
      url: facts.imageUrl,
      note: imageSuggestion || template.imageSuggestion.note,
    },
    carId,
  };

  await writeCache(title, payload, userId);

  return { ...payload, cached: false, source, droppedCount };
};

export default { generateCaptions, Tones, Platforms, Lengths, CAPTION_TYPE, OPTION_COUNT };
