/**
 * @file chatSecurityGuard.js
 * @description Defense-in-depth security guard for the TrustCar Public Chat API (KAN-75).
 *
 * Provides three independent protection layers:
 * 1. Input Prompt Injection Guard:
 *    - Normalizes Unicode & strips invisible characters before matching.
 *    - Detects EN/VI instruction overrides, jailbreaks, system-prompt exfiltration,
 *      confidential business data probes (floorPrice, originalPrice, VIN, internalNotes,
 *      other customers' data), role/delimiter spoofing, and raw DB/SQL injection strings.
 *    - Sanitizes client-provided conversation history (drops `system` roles & poisoned turns).
 * 2. Strict MongoDB Query Whitelist:
 *    - Only allows explicitly whitelisted filter fields, enums, bounded numeric ranges,
 *      escaped regex patterns, fixed sort keys, and a strict public field projection.
 *    - Always enforces `{ status: CarStatus.AVAILABLE, isActive: true }` and `limit <= 3`.
 *    - Rejects any unknown field, `$` operator, dot-path, or prototype-pollution key.
 * 3. LLM Output Guard:
 *    - Scans LLM responses before delivery for system-prompt leaks, confidential field
 *      names/secrets, or hallucinated vehicle codes (`TC-YYYY-NNNN`) absent from DB context.
 */

import { CarStatus, BodyType, FuelType, Transmission } from '../constants/appConstants.js';

// ── Constants & Whitelists ───────────────────────────────────────────────────

export const MAX_CHAT_QUERY_LIMIT = 3;
export const MIN_VALID_YEAR = 1990;
export const MIN_VALID_PRICE_VND = 50_000_000;
export const MAX_VALID_PRICE_VND = 50_000_000_000;

export const ALLOWED_BODY_TYPES = Object.freeze(new Set(Object.values(BodyType)));
export const ALLOWED_FUEL_TYPES = Object.freeze(new Set(Object.values(FuelType)));
export const ALLOWED_TRANSMISSIONS = Object.freeze(new Set(Object.values(Transmission)));
export const ALLOWED_SEAT_COUNTS = Object.freeze(new Set([2, 4, 5, 7, 8, 9]));

export const ALLOWED_FILTER_FIELDS = Object.freeze(
  new Set([
    'vehicleCode',
    'brand',
    'model',
    'bodyType',
    'fuelType',
    'transmission',
    'yearMin',
    'priceMin',
    'priceMax',
    'seats',
    'sortBy',
  ])
);

export const ALLOWED_SORT_MAP = Object.freeze({
  price_asc: Object.freeze({ price: 1 }),
  price_desc: Object.freeze({ price: -1 }),
  mileage_asc: Object.freeze({ mileage: 1 }),
  year_desc: Object.freeze({ year: -1 }),
  newest: Object.freeze({ createdAt: -1 }),
});

/**
 * Frozen public projection for chat vehicle queries.
 * Confidential fields (`floorPrice`, `originalPrice`, `listedPrice`, `vin`,
 * `licensePlate`, `internalNotes`, `priceHistory`, `images.publicId`, audit fields)
 * are strictly excluded.
 */
export const WHITELISTED_CHAT_CAR_PROJECTION = Object.freeze({
  vehicleCode: 1,
  make: 1,
  model: 1,
  variant: 1,
  year: 1,
  bodyType: 1,
  fuelType: 1,
  transmission: 1,
  driveType: 1,
  mileage: 1,
  price: 1,
  marketPrice: 1,
  status: 1,
  'images._id': 1,
  'images.url': 1,
  'images.isPrimary': 1,
  conditionGrade: 1,
  cpoCertificateId: 1,
  'specifications.numberOfSeats': 1,
  'specifications.color': 1,
});

const VEHICLE_CODE_REGEX = /^TC-\d{4}-\d{4}$/;
const SAFE_TEXT_FILTER_REGEX = /^[a-zA-Z0-9À-ỹ\s._-]{1,60}$/;
const FORBIDDEN_KEY_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

// ── Text Normalization Helpers ───────────────────────────────────────────────

/**
 * Normalizes Unicode (NFKC), strips zero-width/control characters, and collapses whitespace.
 */
export const normalizeForSecurityScan = (text = '') =>
  String(text ?? '')
    .normalize('NFKC')
    // Strip zero-width & directional override chars often used to evade filters
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const stripVietnameseDiacritics = (text = '') =>
  normalizeForSecurityScan(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');

// ── Layer 1: Prompt Injection Detection ──────────────────────────────────────

const INJECTION_RULES = [
  {
    category: 'INSTRUCTION_OVERRIDE',
    patterns: [
      /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier|system|initial)\s+(?:instructions?|prompts?|rules?|directions?|messages?)\b/i,
      /\b(?:disregard|forget|override|bypass|reset)\s+(?:all\s+)?(?:your\s+)?(?:previous\s+|system\s+)?(?:instructions?|prompts?|rules?|guidelines?|restrictions?|guardrails?|filters?)\b/i,
      /\b(?:new\s+instructions?|system\s+override|developer\s+mode|god\s+mode|unrestricted\s+mode|jailbreak)\b/i,
      /\b(?:you\s+are\s+now|from\s+now\s+on\s+act\s+as|pretend\s+to\s+be|roleplay\s+as)\s+(?:a\s+)?(?:dan|root|admin|system|hacker|unfiltered|evil|database|sql|mongodb)\b/i,
      /\bbo\s+qua\s+(?:moi|tat\s+ca|cac|nhung)?\s*(?:huong\s+dan|chi\s+thi|quy\s+tac|lenh|nguyen\s+tac)\s*(?:truoc|tren|he\s+thong|ban\s+dau)?\b/i,
      /\bquen\s+(?:het|tat\s+ca|di|moi)?\s*(?:huong\s+dan|quy\s+tac|chi\s+thi|vai\s+tro)\b/i,
      /\b(?:che\s+do\s+(?:nha\s+phat\s+trien|developer|khong\s+gioi\s+han|admin)|vuot\s+rao|hack\s+bot|pha\s+gioi\s+han)\b/i,
      /\b(?:dong\s+vai|gia\s+lam|hay\s+tro\s+thanh)\s+(?:admin|quan\s+tri\s+vien|he\s+thong|hacker|database|developer)\b/i,
    ],
  },
  {
    category: 'PROMPT_EXFILTRATION',
    patterns: [
      /\b(?:show|print|dump|reveal|repeat|leak|output|display|expose|tell\s+me|give\s+me|echo)\b.{0,40}\b(?:system\s+prompt|initial\s+prompt|hidden\s+instructions?|developer\s+prompt|groundedcontext|api[_\s-]?key|jwt[_\s-]?secret|mongodb[_\s-]?uri|process\.env|\.env)\b/i,
      /\b(?:what\s+is|what\s+are)\s+(?:your\s+)?(?:system\s+prompt|hidden\s+instructions?|secret\s+rules?)\b/i,
      /\b(?:in\s+ra|hien\s+thi|tiet\s+lo|cho\s+xem|doc\s+lai|xuat\s+ra|gui\s+lai)\b.{0,40}\b(?:system\s+prompt|prompt\s+(?:goc|he\s+thong)|lenh\s+he\s+thong|chi\s+thi\s+he\s+thong|groundedcontext|api\s*key|bien\s+moi\s+truong|ma\s+bi\s+mat)\b/i,
    ],
  },
  {
    category: 'CONFIDENTIAL_DATA_PROBE',
    patterns: [
      /\b(?:floorprice|floor\s+price|originalprice|original\s+price|internalnotes|internal\s+notes|cost\s+price|purchase\s+price)\b/i,
      /\b(?:gia\s+nhap|gia\s+san|gia\s+goc\s+noi\s+bo|gia\s+von|bien\s+loi\s+nhuan|loi\s+nhuan\s+nhap\s+xe|ghi\s+chu\s+noi\s+bo)\b/i,
      /\b(?:dump|export|list|show|lay|xuat|cho\s+xem|tiet\s+lo)\b.{0,35}\b(?:all\s+users|all\s+leads|all\s+customers|user\s+passwords?|password\s+hash|danh\s+sach\s+(?:khach\s+hang|user|tai\s+khoan|lead|so\s+dien\s+thoai)|mat\s+khau|so\s+vin|khung\s+vin|bien\s+so\s+xe\s+noi\s+bo)\b/i,
    ],
  },
  {
    category: 'DELIMITER_OR_ROLE_SPOOFING',
    patterns: [
      /<\|(?:im_start|im_end|system|assistant|endoftext)\|>/i,
      /<<\s*SYS\s*>>|<\/\s*SYS\s*>/i,
      /(?:^|\n)\s*(?:###\s*)?(?:system|developer)\s*:/i,
      /\[\s*(?:SYSTEM|INST|ADMIN_OVERRIDE)\s*\]/i,
      /<\s*\/?\s*(?:system_prompt|customer_message|grounded_context)\s*>/i,
    ],
  },
  {
    category: 'NOSQL_OR_SQL_INJECTION',
    patterns: [
      /\$(?:where|ne|gt|gte|lt|lte|in|nin|regex|expr|lookup|function|accumulator|out|merge)\b/i,
      /\bdb\.[a-z_]+\.(?:find|findone|aggregate|update|delete|drop|remove)\b/i,
      /\b(?:union\s+select|drop\s+table|delete\s+from|insert\s+into|;\s*--\s*|'\s*or\s+'?1'?\s*=\s*'?1)\b/i,
      /\b(?:__proto__|constructor\.prototype)\b/i,
    ],
  },
];

/**
 * Inspects user input for prompt injection, jailbreak, confidential data probes,
 * delimiter spoofing, or raw query injection payloads.
 *
 * @param {string} rawText
 * @returns {{ blocked: boolean, category: string | null }}
 */
export const detectPromptInjection = (rawText = '') => {
  const normalizedRaw = normalizeForSecurityScan(rawText);
  if (!normalizedRaw) return { blocked: false, category: null };

  const asciiNorm = stripVietnameseDiacritics(normalizedRaw);

  for (const rule of INJECTION_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(normalizedRaw) || pattern.test(asciiNorm)) {
        return { blocked: true, category: rule.category };
      }
    }
  }

  return { blocked: false, category: null };
};

/**
 * Strips delimiter/role-injection markers from safe user/assistant text before sending to LLM.
 */
export const stripUnsafePromptDelimiters = (text = '') =>
  normalizeForSecurityScan(text)
    .replace(/<\|[^|]{1,32}\|>/g, ' ')
    .replace(/<<\s*\/?\s*SYS\s*>>/gi, ' ')
    .replace(/<\s*\/?\s*(?:system_prompt|customer_message|grounded_context)\s*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Sanitizes conversation history sent from client:
 * - Strictly accepts only `user` and `assistant` roles (never `system`).
 * - Drops any turn that triggers prompt injection detection (blocks indirect/multi-turn injection).
 * - Clamps turn count and per-turn character length.
 *
 * @param {Array<{role: string, content: string}>} history
 * @param {{ maxTurns?: number, maxCharsPerTurn?: number }} [options]
 * @returns {Array<{role: 'user'|'assistant', content: string}>}
 */
export const sanitizeChatHistory = (history = [], options = {}) => {
  const maxTurns = Number(options.maxTurns) || 6;
  const maxCharsPerTurn = Number(options.maxCharsPerTurn) || 600;
  if (!Array.isArray(history)) return [];

  const clean = [];
  for (const item of history) {
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) continue;
    if (typeof item.content !== 'string') continue;

    const text = stripUnsafePromptDelimiters(item.content).slice(0, maxCharsPerTurn);
    if (!text) continue;

    // Never carry poisoned turns into the LLM context
    if (detectPromptInjection(text).blocked) continue;

    clean.push({ role: item.role, content: text });
  }

  return clean.slice(-maxTurns);
};

/**
 * Polite, firm Vietnamese response returned when the prompt injection guard blocks a message.
 */
export const buildGuardRefusalReply = (category, showroom = null) => {
  const phoneDisplay = showroom?.contact?.phoneDisplay || '0856 098 686';

  if (category === 'CONFIDENTIAL_DATA_PROBE') {
    return [
      'Xin lỗi, mình là Trợ lý AI tư vấn khách hàng của TrustCar nên chỉ có thể cung cấp thông tin công khai về các mẫu xe đang mở bán, giá niêm yết, chứng nhận kiểm định CPO và ước tính trả góp.',
      `Mình không có quyền truy cập hay cung cấp dữ liệu nội bộ, giá nhập hoặc thông tin của khách hàng khác. Nếu bạn cần hỗ trợ chính thức, vui lòng liên hệ Hotline ${phoneDisplay}.`,
    ].join('\n');
  }

  return [
    'Xin lỗi, yêu cầu vừa rồi nằm ngoài phạm vi hỗ trợ của Trợ lý AI Showroom TrustCar.',
    'Mình có thể hỗ trợ bạn tìm xe đã qua sử dụng đang mở bán theo hãng/kiểu dáng/ngân sách, ước tính trả góp hàng tháng, kiểm tra tiêu chuẩn CPO 150 điểm hoặc đặt lịch lái thử trực tiếp tại Showroom!',
  ].join('\n');
};

// ── Layer 2: Strict Query Whitelist Builder ──────────────────────────────────

const escapeRegex = (str = '') => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Validates and builds a strictly whitelisted MongoDB query object for public `Car` lookup.
 *
 * Security guarantees:
 * - Always locks `{ status: CarStatus.AVAILABLE, isActive: true }`.
 * - Drops any unknown key, `$` operator, dot-path, or prototype-pollution key.
 * - Validates every enum, numeric bound, vehicleCode format, sort key, and result limit.
 *
 * @param {object} rawFilters - Extracted NLU filters or untrusted filter object.
 * @param {number} [requestedLimit=3]
 * @returns {{
 *   mongoFilter: object,
 *   sort: object,
 *   projection: object,
 *   limit: number,
 *   appliedFilters: object,
 *   rejectedFields: string[],
 *   isExactVehicleCode: boolean,
 * }}
 */
export const buildWhitelistedCarQuery = (rawFilters = {}, requestedLimit = MAX_CHAT_QUERY_LIMIT) => {
  const currentYear = new Date().getFullYear();
  const safeInput =
    rawFilters && typeof rawFilters === 'object' && !Array.isArray(rawFilters) ? rawFilters : {};

  const rejectedFields = [];
  const appliedFilters = {};

  // Always enforce public availability invariant
  const mongoFilter = {
    status: CarStatus.AVAILABLE,
    isActive: true,
  };

  for (const key of Object.keys(safeInput)) {
    if (
      FORBIDDEN_KEY_NAMES.has(key) ||
      key.startsWith('$') ||
      key.includes('.') ||
      !ALLOWED_FILTER_FIELDS.has(key)
    ) {
      rejectedFields.push(key);
    }
  }

  // 1. vehicleCode (exact match only, strict pattern TC-YYYY-NNNN)
  if (safeInput.vehicleCode !== undefined && safeInput.vehicleCode !== null) {
    const code = String(safeInput.vehicleCode).trim().toUpperCase();
    if (VEHICLE_CODE_REGEX.test(code)) {
      appliedFilters.vehicleCode = code;
      mongoFilter.vehicleCode = code;
      return {
        mongoFilter,
        sort: ALLOWED_SORT_MAP.newest,
        projection: WHITELISTED_CHAT_CAR_PROJECTION,
        limit: 1,
        appliedFilters,
        rejectedFields,
        isExactVehicleCode: true,
      };
    }
    rejectedFields.push('vehicleCode');
  }

  // 2. brand -> make (regex-escaped, strict safe character set)
  if (safeInput.brand !== undefined && safeInput.brand !== null && safeInput.brand !== '') {
    const brand = String(safeInput.brand).trim();
    if (SAFE_TEXT_FILTER_REGEX.test(brand) && !brand.includes('$')) {
      appliedFilters.brand = brand;
      mongoFilter.make = { $regex: `^${escapeRegex(brand)}$`, $options: 'i' };
    } else {
      rejectedFields.push('brand');
    }
  }

  // 3. model (regex-escaped, strict safe character set)
  if (safeInput.model !== undefined && safeInput.model !== null && safeInput.model !== '') {
    const model = String(safeInput.model).trim();
    if (SAFE_TEXT_FILTER_REGEX.test(model) && !model.includes('$')) {
      appliedFilters.model = model;
      mongoFilter.model = { $regex: escapeRegex(model), $options: 'i' };
    } else {
      rejectedFields.push('model');
    }
  }

  // 4. Enum fields: bodyType, fuelType, transmission
  if (safeInput.bodyType !== undefined && safeInput.bodyType !== null && safeInput.bodyType !== '') {
    const bodyType = String(safeInput.bodyType).trim().toUpperCase();
    if (ALLOWED_BODY_TYPES.has(bodyType)) {
      appliedFilters.bodyType = bodyType;
      mongoFilter.bodyType = bodyType;
    } else {
      rejectedFields.push('bodyType');
    }
  }

  if (safeInput.fuelType !== undefined && safeInput.fuelType !== null && safeInput.fuelType !== '') {
    const fuelType = String(safeInput.fuelType).trim().toUpperCase();
    if (ALLOWED_FUEL_TYPES.has(fuelType)) {
      appliedFilters.fuelType = fuelType;
      mongoFilter.fuelType = fuelType;
    } else {
      rejectedFields.push('fuelType');
    }
  }

  if (
    safeInput.transmission !== undefined &&
    safeInput.transmission !== null &&
    safeInput.transmission !== ''
  ) {
    const transmission = String(safeInput.transmission).trim().toUpperCase();
    if (ALLOWED_TRANSMISSIONS.has(transmission)) {
      appliedFilters.transmission = transmission;
      mongoFilter.transmission = transmission;
    } else {
      rejectedFields.push('transmission');
    }
  }

  // 5. Numeric bounds: yearMin
  if (safeInput.yearMin !== undefined && safeInput.yearMin !== null && safeInput.yearMin !== '') {
    const yr = Number(safeInput.yearMin);
    if (Number.isInteger(yr) && yr >= MIN_VALID_YEAR && yr <= currentYear + 1) {
      appliedFilters.yearMin = yr;
      mongoFilter.year = { $gte: yr };
    } else {
      rejectedFields.push('yearMin');
    }
  }

  // 6. Numeric bounds: priceMin & priceMax
  let priceMin = null;
  let priceMax = null;

  if (safeInput.priceMin !== undefined && safeInput.priceMin !== null && safeInput.priceMin !== '') {
    const pMin = Number(safeInput.priceMin);
    if (Number.isFinite(pMin) && pMin >= MIN_VALID_PRICE_VND && pMin <= MAX_VALID_PRICE_VND) {
      priceMin = Math.round(pMin);
    } else {
      rejectedFields.push('priceMin');
    }
  }

  if (safeInput.priceMax !== undefined && safeInput.priceMax !== null && safeInput.priceMax !== '') {
    const pMax = Number(safeInput.priceMax);
    if (Number.isFinite(pMax) && pMax >= MIN_VALID_PRICE_VND && pMax <= MAX_VALID_PRICE_VND) {
      priceMax = Math.round(pMax);
    } else {
      rejectedFields.push('priceMax');
    }
  }

  if (priceMin !== null && priceMax !== null && priceMin > priceMax) {
    const swapped = priceMin;
    priceMin = priceMax;
    priceMax = swapped;
  }

  if (priceMin !== null || priceMax !== null) {
    mongoFilter.price = {};
    if (priceMin !== null) {
      appliedFilters.priceMin = priceMin;
      mongoFilter.price.$gte = priceMin;
    }
    if (priceMax !== null) {
      appliedFilters.priceMax = priceMax;
      mongoFilter.price.$lte = priceMax;
    }
  }

  // 7. Whitelisted seats filter
  if (safeInput.seats !== undefined && safeInput.seats !== null && safeInput.seats !== '') {
    const seats = Number(safeInput.seats);
    if (Number.isInteger(seats) && ALLOWED_SEAT_COUNTS.has(seats)) {
      appliedFilters.seats = seats;
      if (seats >= 7) {
        mongoFilter.$or = [
          { 'specifications.numberOfSeats': { $gte: seats } },
          { bodyType: { $in: [BodyType.SUV, BodyType.MPV] } },
        ];
      }
    } else {
      rejectedFields.push('seats');
    }
  }

  // 8. Whitelisted sort key
  let sort = ALLOWED_SORT_MAP.newest;
  if (safeInput.sortBy !== undefined && safeInput.sortBy !== null && safeInput.sortBy !== '') {
    const sortKey = String(safeInput.sortBy).trim();
    if (Object.prototype.hasOwnProperty.call(ALLOWED_SORT_MAP, sortKey)) {
      appliedFilters.sortBy = sortKey;
      sort = ALLOWED_SORT_MAP[sortKey];
    } else {
      rejectedFields.push('sortBy');
    }
  }

  // 9. Bounded result limit (1..3)
  const parsedLimit = Number(requestedLimit);
  const limit = Number.isInteger(parsedLimit)
    ? Math.max(1, Math.min(MAX_CHAT_QUERY_LIMIT, parsedLimit))
    : MAX_CHAT_QUERY_LIMIT;

  return {
    mongoFilter,
    sort,
    projection: WHITELISTED_CHAT_CAR_PROJECTION,
    limit,
    appliedFilters,
    rejectedFields,
    isExactVehicleCode: false,
  };
};

// ── Layer 3: LLM Output Guard ────────────────────────────────────────────────

const FORBIDDEN_OUTPUT_PATTERNS = [
  /\b(?:floorPrice|originalPrice|internalNotes|groundedContext|SYSTEM_PROMPT)\b/i,
  /\b(?:CHAT_LLM_API_KEY|CAPTION_LLM_API_KEY|MONGODB_URI|JWT_SECRET|MAILERSEND_API_KEY)\b/i,
  /\bQuy tắc bắt buộc:\s*1\.\s*Trả lời bằng tiếng Việt/i,
  /\bdb\.(?:cars|users|leads|deposits)\./i,
  /mongodb\+srv:\/\//i,
];

const VEHICLE_CODE_GLOBAL_REGEX = /\bTC-\d{4}-\d{4}\b/gi;

/**
 * Post-validates an LLM reply before returning it to the customer:
 * 1. Rejects any reply leaking internal field names, env secrets, DB commands, or system prompt text.
 * 2. Rejects any reply citing a `TC-YYYY-NNNN` vehicle code not present in `groundedContext`.
 *
 * @param {string} replyText
 * @param {object} [groundedContext={}]
 * @returns {{ safe: boolean, reason: string | null }}
 */
export const validateLlmReply = (replyText = '', groundedContext = {}) => {
  const text = String(replyText ?? '').trim();
  if (!text) return { safe: false, reason: 'EMPTY_REPLY' };

  for (const pattern of FORBIDDEN_OUTPUT_PATTERNS) {
    if (pattern.test(text)) {
      return { safe: false, reason: 'SENSITIVE_LEAK' };
    }
  }

  // Grounding check: any cited TC-YYYY-NNNN code must exist in the provided groundedContext cars
  const mentionedCodes = text.match(VEHICLE_CODE_GLOBAL_REGEX) || [];
  if (mentionedCodes.length > 0) {
    const allowedCodes = new Set(
      [
        ...(Array.isArray(groundedContext?.matchedCars) ? groundedContext.matchedCars : []),
        ...(Array.isArray(groundedContext?.alternativeCars) ? groundedContext.alternativeCars : []),
      ]
        .map((c) => String(c?.vehicleCode || '').toUpperCase())
        .filter(Boolean)
    );

    for (const code of mentionedCodes) {
      if (!allowedCodes.has(code.toUpperCase())) {
        return { safe: false, reason: 'UNGROUNDED_VEHICLE_CODE' };
      }
    }
  }

  return { safe: true, reason: null };
};

export default {
  MAX_CHAT_QUERY_LIMIT,
  ALLOWED_BODY_TYPES,
  ALLOWED_FUEL_TYPES,
  ALLOWED_TRANSMISSIONS,
  ALLOWED_SEAT_COUNTS,
  ALLOWED_FILTER_FIELDS,
  ALLOWED_SORT_MAP,
  WHITELISTED_CHAT_CAR_PROJECTION,
  normalizeForSecurityScan,
  detectPromptInjection,
  stripUnsafePromptDelimiters,
  sanitizeChatHistory,
  buildGuardRefusalReply,
  buildWhitelistedCarQuery,
  validateLlmReply,
};
