/**
 * @file chatService.js
 * @description Intelligent Hybrid-AI Chatbot service for TrustCar (/api/v1/public/chat).
 *
 * Responsibilities:
 * 1. Extract Vietnamese intents & vehicle filter entities (with conversation history carry-over).
 * 2. Query real MongoDB data (`Car`, `SystemSetting` for showroom & loan settings).
 * 3. Persist conversation sessions (`ChatConversation`) and messages (`ChatMessage`) in MongoDB.
 * 4. Capture visitor phone numbers into the CRM Lead pipeline (`Lead` + `Customer`).
 * 5. Generate natural Vietnamese replies via OpenAI-compatible LLM grounded on real DB data,
 *    with automatic deterministic fallback when no LLM key is configured or provider times out.
 */

import Car from '../models/Car.js';
import ChatConversation from '../models/chat-conversation.model.js';
import ChatMessage from '../models/chat-message.model.js';
import { ConversationStatus, SenderType } from '../models/extendedEnums.js';
import { CarStatus, BodyType, FuelType, Transmission } from '../constants/appConstants.js';
import { toPublicCar } from './publicCarService.js';
import { getBaseSettings } from './baseSettingsService.js';
import { getLoanSettings } from './loanSettingsService.js';
import { createPublicEnquiry } from './leadService.js';
import { generateGroundedChatCompletion } from './chatLlmClient.js';
import { normalizePhone, isValidVietnamesePhone } from '../utils/validators.js';

// ── Constants & Lookup Tables ────────────────────────────────────────────────

const CHAT_CAR_PROJECTION = {
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
  images: 1,
  conditionGrade: 1,
  cpoCertificateId: 1,
  'specifications.numberOfSeats': 1,
  'specifications.color': 1,
};

const BRAND_PATTERNS = [
  { brand: 'Toyota', regex: /\b(toyota)\b/i },
  { brand: 'Honda', regex: /\b(honda)\b/i },
  { brand: 'Mazda', regex: /\b(mazda)\b/i },
  { brand: 'Hyundai', regex: /\b(hyundai|huyndai)\b/i },
  { brand: 'Kia', regex: /\b(kia)\b/i },
  { brand: 'Ford', regex: /\b(ford)\b/i },
  { brand: 'VinFast', regex: /\b(vinfast|vin\s*fast)\b/i },
  { brand: 'Mitsubishi', regex: /\b(mitsubishi|mitsu)\b/i },
  { brand: 'Mercedes-Benz', regex: /\b(mercedes|merc|mer)\b/i },
  { brand: 'BMW', regex: /\b(bmw)\b/i },
  { brand: 'Audi', regex: /\b(audi)\b/i },
  { brand: 'Lexus', regex: /\b(lexus)\b/i },
  { brand: 'Peugeot', regex: /\b(peugeot)\b/i },
  { brand: 'Suzuki', regex: /\b(suzuki)\b/i },
  { brand: 'Nissan', regex: /\b(nissan)\b/i },
  { brand: 'MG', regex: /\b(mg)\b/i },
  { brand: 'Subaru', regex: /\b(subaru)\b/i },
];

const MODEL_PATTERNS = [
  { model: 'Camry', brand: 'Toyota', regex: /\b(camry)\b/i },
  { model: 'Corolla Cross', brand: 'Toyota', regex: /\b(corolla\s*cross|cross)\b/i },
  { model: 'Vios', brand: 'Toyota', regex: /\b(vios)\b/i },
  { model: 'Fortuner', brand: 'Toyota', regex: /\b(fortuner)\b/i },
  { model: 'Innova', brand: 'Toyota', regex: /\b(innova)\b/i },
  { model: 'Veloz', brand: 'Toyota', regex: /\b(veloz)\b/i },
  { model: 'Raize', brand: 'Toyota', regex: /\b(raize)\b/i },
  { model: 'CR-V', brand: 'Honda', regex: /\b(cr-?v|crv)\b/i },
  { model: 'HR-V', brand: 'Honda', regex: /\b(hr-?v|hrv)\b/i },
  { model: 'Civic', brand: 'Honda', regex: /\b(civic)\b/i },
  { model: 'City', brand: 'Honda', regex: /\b(city)\b/i },
  { model: 'Accord', brand: 'Honda', regex: /\b(accord)\b/i },
  { model: 'CX-5', brand: 'Mazda', regex: /\b(cx-?5|cx5)\b/i },
  { model: 'CX-8', brand: 'Mazda', regex: /\b(cx-?8|cx8)\b/i },
  { model: 'CX-3', brand: 'Mazda', regex: /\b(cx-?3|cx3)\b/i },
  { model: 'Mazda3', brand: 'Mazda', regex: /\b(mazda\s*3|m3)\b/i },
  { model: 'Mazda6', brand: 'Mazda', regex: /\b(mazda\s*6|m6)\b/i },
  { model: 'Tucson', brand: 'Hyundai', regex: /\b(tucson)\b/i },
  { model: 'Santa Fe', brand: 'Hyundai', regex: /\b(santa\s*fe|santafe)\b/i },
  { model: 'Accent', brand: 'Hyundai', regex: /\b(accent)\b/i },
  { model: 'Creta', brand: 'Hyundai', regex: /\b(creta)\b/i },
  { model: 'Elantra', brand: 'Hyundai', regex: /\b(elantra)\b/i },
  { model: 'Seltos', brand: 'Kia', regex: /\b(seltos)\b/i },
  { model: 'Sonet', brand: 'Kia', regex: /\b(sonet)\b/i },
  { model: 'Carnival', brand: 'Kia', regex: /\b(carnival|sedona)\b/i },
  { model: 'Sorento', brand: 'Kia', regex: /\b(sorento)\b/i },
  { model: 'K3', brand: 'Kia', regex: /\b(k3|cerato)\b/i },
  { model: 'Morning', brand: 'Kia', regex: /\b(morning)\b/i },
  { model: 'Everest', brand: 'Ford', regex: /\b(everest)\b/i },
  { model: 'Ranger', brand: 'Ford', regex: /\b(ranger)\b/i },
  { model: 'Territory', brand: 'Ford', regex: /\b(territory)\b/i },
  { model: 'VF 5', brand: 'VinFast', regex: /\b(vf\s*5|vf5)\b/i },
  { model: 'VF 6', brand: 'VinFast', regex: /\b(vf\s*6|vf6)\b/i },
  { model: 'VF 7', brand: 'VinFast', regex: /\b(vf\s*7|vf7)\b/i },
  { model: 'VF 8', brand: 'VinFast', regex: /\b(vf\s*8|vf8)\b/i },
  { model: 'VF 9', brand: 'VinFast', regex: /\b(vf\s*9|vf9)\b/i },
  { model: 'Fadil', brand: 'VinFast', regex: /\b(fadil)\b/i },
  { model: 'Xpander', brand: 'Mitsubishi', regex: /\b(xpander)\b/i },
  { model: 'Outlander', brand: 'Mitsubishi', regex: /\b(outlander)\b/i },
  { model: 'Attrage', brand: 'Mitsubishi', regex: /\b(attrage)\b/i },
];

// ── Text & Currency Helpers ──────────────────────────────────────────────────

export const normalizeVietnameseText = (text = '') =>
  String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();

export const formatVndPrice = (price) => {
  const num = Number(price);
  if (!Number.isFinite(num) || num <= 0) return 'Liên hệ';
  if (num >= 1_000_000_000) {
    const billions = Math.floor(num / 1_000_000_000);
    const millions = Math.round((num % 1_000_000_000) / 1_000_000);
    return millions > 0 ? `${billions} tỷ ${millions} triệu` : `${billions} tỷ`;
  }
  return `${Math.round(num / 1_000_000)} triệu`;
};

const toVndValue = (rawNum, unit = '') => {
  const val = parseFloat(String(rawNum).replace(',', '.'));
  if (Number.isNaN(val) || val <= 0) return null;
  const u = normalizeVietnameseText(unit);
  if (u.startsWith('ty') || u.startsWith('ti') || val < 25) {
    return Math.round(val * 1_000_000_000);
  }
  return Math.round(val * 1_000_000);
};

/**
 * Parses Vietnamese price expressions such as:
 * - "dưới 700 triệu", "dưới 1.2 tỷ", "dưới 1 tỷ 2"
 * - "từ 500 đến 800 triệu", "500 - 700tr"
 * - "trên 900 triệu"
 * - "tầm 600 triệu", "khoảng 1 tỷ"
 */
export const parsePriceRangeFromText = (rawText = '') => {
  const norm = normalizeVietnameseText(rawText);
  if (!norm) return null;

  // Handle compound "1 ty 2" -> "1.2 ty"
  const normalizedCompound = norm.replace(
    /(\d+)\s*(?:ty|ti)\s*(\d{1,3})\b/g,
    (_match, b, m) => {
      const decimal = String(m).length === 1 ? Number(m) / 10 : Number(m) / 1000;
      return `${Number(b) + decimal} ty`;
    }
  );

  // 1. Explicit range: "tu 500 den 800 trieu" / "500 - 800 tr"
  const rangeMatch = normalizedCompound.match(
    /(?:tu|khoang|tam)?\s*(\d+(?:[.,]\d+)?)\s*(ty|ti|trieu|tr|củ|cu)?\s*(?:den|-|toi|~)\s*(\d+(?:[.,]\d+)?)\s*(ty|ti|trieu|tr|củ|cu)/
  );
  if (rangeMatch) {
    const unit2 = rangeMatch[4];
    const unit1 = rangeMatch[2] || unit2;
    const min = toVndValue(rangeMatch[1], unit1);
    const max = toVndValue(rangeMatch[3], unit2);
    if (min && max) {
      return {
        priceMin: Math.min(min, max),
        priceMax: Math.max(min, max),
        label: `từ ${formatVndPrice(Math.min(min, max))} đến ${formatVndPrice(Math.max(min, max))}`,
      };
    }
  }

  // 2. Ceiling: "duoi 700 trieu", "toi da 800tr", "< 600 trieu"
  const underMatch = normalizedCompound.match(
    /(?:duoi|nho hon|thap hon|toi da|khong qua|<|<=)\s*(\d+(?:[.,]\d+)?)\s*(ty|ti|trieu|tr|cu)/
  );
  if (underMatch) {
    const max = toVndValue(underMatch[1], underMatch[2]);
    if (max) {
      return { priceMax: max, label: `dưới ${formatVndPrice(max)}` };
    }
  }

  // 3. Floor: "tren 800 trieu", "hon 1 ty", "> 900tr"
  const overMatch = normalizedCompound.match(
    /(?:tren|lon hon|cao hon|tu|>|>=)\s*(\d+(?:[.,]\d+)?)\s*(ty|ti|trieu|tr|cu)/
  );
  if (overMatch) {
    const min = toVndValue(overMatch[1], overMatch[2]);
    if (min) {
      return { priceMin: min, label: `trên ${formatVndPrice(min)}` };
    }
  }

  // 4. Approximate: "tam 600 trieu", "khoang 700tr", "loanh quanh 1 ty", or standalone "700 trieu"
  // Avoid matching down-payment amounts ("tra truoc 200 trieu")
  if (!/tra truoc\s+\d+/.test(normalizedCompound)) {
    const approxMatch = normalizedCompound.match(
      /(?:tam|khoang|loanh quanh|quanh|gia|muc gia|tai chinh|ngan sach)?\s*(\d+(?:[.,]\d+)?)\s*(ty|ti|trieu|tr|cu)\b/
    );
    if (approxMatch) {
      const target = toVndValue(approxMatch[1], approxMatch[2]);
      if (target && target >= 150_000_000) {
        const delta = Math.round(target * 0.18);
        return {
          priceMin: Math.max(100_000_000, target - delta),
          priceMax: target + delta,
          targetPrice: target,
          label: `tầm ${formatVndPrice(target)}`,
        };
      }
    }
  }

  return null;
};

/**
 * Extracts filters from a single text string.
 */
export const extractEntitiesFromSingleText = (text = '') => {
  const raw = String(text || '').trim();
  const norm = normalizeVietnameseText(raw);

  const entities = {};

  // Vehicle Code (TC-YYYY-NNNN)
  const codeMatch = raw.match(/\b(TC-\d{4}-\d{4})\b/i);
  if (codeMatch) {
    entities.vehicleCode = codeMatch[1].toUpperCase();
  }

  // Model & Brand detection
  for (const item of MODEL_PATTERNS) {
    if (item.regex.test(norm) || item.regex.test(raw)) {
      entities.model = item.model;
      entities.brand = item.brand;
      break;
    }
  }

  if (!entities.brand) {
    for (const item of BRAND_PATTERNS) {
      if (item.regex.test(norm) || item.regex.test(raw)) {
        entities.brand = item.brand;
        break;
      }
    }
  }

  // BodyType detection
  if (/\b(suv|gam cao|crossover|cuv)\b/.test(norm)) {
    entities.bodyType = BodyType.SUV;
  } else if (/\b(sedan|4 cho gam thap)\b/.test(norm)) {
    entities.bodyType = BodyType.SEDAN;
  } else if (/\b(hatchback|hatback|hb|xe nho do thi|xe co a)\b/.test(norm)) {
    entities.bodyType = BodyType.HATCHBACK;
  } else if (/\b(ban tai|pickup|pick-up)\b/.test(norm)) {
    entities.bodyType = BodyType.PICKUP;
  } else if (/\b(mpv|da dung)\b/.test(norm)) {
    entities.bodyType = BodyType.MPV;
  }

  // Seats heuristic (7-seater usually maps to SUV/MPV or numberOfSeats >= 7)
  if (/\b(7 cho|8 cho|gia dinh dong nguoi)\b/.test(norm)) {
    entities.seats = 7;
    if (!entities.bodyType) entities.bodyType = BodyType.SUV;
  } else if (/\b(5 cho|4 cho)\b/.test(norm)) {
    entities.seats = 5;
  }

  // FuelType detection
  if (/\b(may dau|xe dau|diesel)\b/.test(norm)) {
    entities.fuelType = FuelType.DIESEL;
  } else if (/\b(hybrid|xang lai dien|lai dien)\b/.test(norm)) {
    entities.fuelType = FuelType.HYBRID;
  } else if (/\b(xe dien|thuan dien|chay dien)\b/.test(norm)) {
    entities.fuelType = FuelType.ELECTRIC;
  } else if (/\b(may xang|xe xang|chay xang)\b/.test(norm)) {
    entities.fuelType = FuelType.GASOLINE;
  }

  // Transmission detection
  if (/\b(so tu dong|tu dong|\bat\b)\b/.test(norm)) {
    entities.transmission = Transmission.AUTOMATIC;
  } else if (/\b(so san|\bmt\b)\b/.test(norm)) {
    entities.transmission = Transmission.MANUAL;
  } else if (/\b(cvt|vo cap)\b/.test(norm)) {
    entities.transmission = Transmission.CVT;
  }

  // Year detection (e.g. "đời 2022", "từ 2021", "năm 2023")
  const yearFromMatch = norm.match(/(?:tu doi|tu nam|doi tu)\s*(20[12]\d)\b/);
  const exactYearMatch = norm.match(/(?:doi|nam|san xuat)\s*(20[12]\d)\b/);
  if (yearFromMatch) {
    entities.yearMin = Number(yearFromMatch[1]);
  } else if (exactYearMatch) {
    entities.yearMin = Number(exactYearMatch[1]);
  }

  // Price range detection
  const priceRange = parsePriceRangeFromText(raw);
  if (priceRange) {
    if (priceRange.priceMin) entities.priceMin = priceRange.priceMin;
    if (priceRange.priceMax) entities.priceMax = priceRange.priceMax;
    if (priceRange.targetPrice) entities.targetPrice = priceRange.targetPrice;
    entities.priceLabel = priceRange.label;
  }

  // Sort preference
  if (/\b(re nhat|gia thap nhat|gia mem)\b/.test(norm)) {
    entities.sortBy = 'price_asc';
  } else if (/\b(odo thap|it di|chay luot|moi di)\b/.test(norm)) {
    entities.sortBy = 'mileage_asc';
  } else if (/\b(doi cao|doi moi nhat|moi ve)\b/.test(norm)) {
    entities.sortBy = 'year_desc';
  }

  return entities;
};

/**
 * Extracts primary intent, merged entities (with history carry-over), and phone/lead details.
 */
export const analyzeConversationTurn = (message = '', history = []) => {
  const raw = String(message || '').trim();
  const norm = normalizeVietnameseText(raw);

  // Extract phone number if present
  const phoneMatch = raw.replace(/[\s.()-]/g, '').match(/(?:\+84|0)[3-9]\d{8}/);
  const rawPhone = phoneMatch ? phoneMatch[0] : null;
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  const validPhone = phone && isValidVietnamesePhone(phone) ? phone : null;

  // Extract customer name if mentioned near phone or introduction
  let customerName = null;
  const nameMatch = raw.match(
    /(?:tên\s+(?:tôi|mình|em|anh|chị)\s+là|mình\s+là|tôi\s+là|anh\s+là|chị\s+là)\s+([A-ZÀ-Ỹa-zà-ỹ]+(?:\s+[A-ZÀ-Ỹa-zà-ỹ]+){0,3})/i
  );
  if (nameMatch && nameMatch[1]) {
    customerName = nameMatch[1].trim();
  }

  const currentEntities = extractEntitiesFromSingleText(raw);

  // Carry over filter context from the last 2 user turns if the current turn is a follow-up
  const historyEntities = {};
  if (Array.isArray(history) && history.length > 0) {
    const recentUserMessages = history
      .filter((h) => h && h.role === 'user' && typeof h.content === 'string')
      .slice(-2);
    for (const turn of recentUserMessages) {
      Object.assign(historyEntities, extractEntitiesFromSingleText(turn.content));
    }
  }

  const hasCurrentCarCriteria = Boolean(
    currentEntities.vehicleCode ||
      currentEntities.brand ||
      currentEntities.model ||
      currentEntities.bodyType ||
      currentEntities.fuelType ||
      currentEntities.transmission ||
      currentEntities.priceMin ||
      currentEntities.priceMax ||
      currentEntities.yearMin ||
      currentEntities.seats
  );

  // Merge history context when current message refines or asks about finance/test-drive/CPO
  const isContextualFollowUp =
    /\b(the con|vay con|chiec do|mau do|xe do|tra gop|lai thu|kiem dinh|cpo|mau trang|mau den|so tu dong|may dau|may xang)\b/.test(
      norm
    ) ||
    (! currentEntities.brand &&
      !currentEntities.bodyType &&
      Boolean(
        currentEntities.priceMin ||
          currentEntities.priceMax ||
          currentEntities.fuelType ||
          currentEntities.transmission
      ));

  const mergedFilters = isContextualFollowUp
    ? { ...historyEntities, ...currentEntities }
    : { ...currentEntities };

  // Classify primary intent
  let intent = 'GENERAL';
  if (validPhone) {
    intent = 'LEAD_PHONE';
  } else if (currentEntities.vehicleCode) {
    intent = 'VEHICLE_DETAIL';
  } else if (
    /\b(tra gop|vay|ngan hang|lai suat|tra truoc|moi thang|gop hang thang)\b/.test(norm)
  ) {
    intent = 'FINANCE_LOAN';
  } else if (
    /\b(lai thu|dat lich|xem xe|hen lich|trai nghiem xe|qua xem)\b/.test(norm)
  ) {
    intent = 'TEST_DRIVE_BOOKING';
  } else if (
    /\b(cpo|kiem dinh|bao hanh|hang muc|담 bao|dam bao| ngập nuoc|ngap nuoc|dam dung|tai nan|chung nhan)\b/.test(
      norm
    )
  ) {
    intent = 'CPO_WARRANTY';
  } else if (
    /\b(thu mua|ban xe|doi xe|dinh gia|ky gui|ban lai|thu cu doi moi)\b/.test(norm)
  ) {
    intent = 'SELL_TRADE_IN';
  } else if (
    /\b(dia chi|o dau|gio mo cua|lien he|hotline|so dien thoai|zalo|showroom|ban do|chi duong)\b/.test(
      norm
    ) &&
    !hasCurrentCarCriteria
  ) {
    intent = 'SHOWROOM_INFO';
  } else if (
    hasCurrentCarCriteria ||
    /\b(tim xe|mua xe|tu van xe|goi y|co xe nao|mau xe|dong xe|xe gia dinh|xe luot)\b/.test(norm)
  ) {
    intent = 'CAR_SEARCH';
  } else if (/\b(xin chao|chao|hello|hi|alo|shop oi|ad oi|tu van)\b/.test(norm)) {
    intent = 'GREETING';
  }

  return {
    intent,
    filters: mergedFilters,
    hasCarCriteria: Boolean(
      mergedFilters.vehicleCode ||
        mergedFilters.brand ||
        mergedFilters.model ||
        mergedFilters.bodyType ||
        mergedFilters.fuelType ||
        mergedFilters.transmission ||
        mergedFilters.priceMin ||
        mergedFilters.priceMax ||
        mergedFilters.yearMin ||
        mergedFilters.seats
    ),
    phone: validPhone,
    customerName,
    normalizedMessage: norm,
  };
};

// ── Loan Calculator Helper ───────────────────────────────────────────────────

export const computeLoanEstimate = (rawText = '', loanSettings = {}, referencePrice = null) => {
  const norm = normalizeVietnameseText(rawText);
  const priceFromText = parsePriceRangeFromText(rawText);
  const vehiclePrice =
    referencePrice ||
    priceFromText?.targetPrice ||
    priceFromText?.priceMax ||
    priceFromText?.priceMin ||
    700_000_000;

  const minDownPct = Number(loanSettings.minDownPaymentPct) || 20;
  let downPaymentPct = Math.max(minDownPct, 30);

  const pctMatch = norm.match(/tra truoc\s*(\d{1,2})\s*%/);
  if (pctMatch) {
    downPaymentPct = Math.min(80, Math.max(minDownPct, Number(pctMatch[1])));
  }

  const minTermMonths = Number(loanSettings.minTermMonths) || 12;
  const maxTermMonths = Number(loanSettings.maxTermMonths) || 84;
  let termMonths = Math.min(60, maxTermMonths);

  const yearTermMatch = norm.match(/(\d)\s*nam/);
  const monthTermMatch = norm.match(/(\d{2})\s*thang/);
  if (yearTermMatch) {
    termMonths = Math.min(maxTermMonths, Math.max(minTermMonths, Number(yearTermMatch[1]) * 12));
  } else if (monthTermMatch) {
    termMonths = Math.min(maxTermMonths, Math.max(minTermMonths, Number(monthTermMatch[1])));
  }

  const annualRate = Number(loanSettings.preferredRateAnnual) || 8.5;
  const floatingRate = Number(loanSettings.floatingRateAnnual) || 10.5;
  const downPaymentAmount = Math.round((vehiclePrice * downPaymentPct) / 100);
  const loanPrincipal = Math.max(0, vehiclePrice - downPaymentAmount);

  const monthlyRate = annualRate / 100 / 12;
  const monthlyPayment =
    monthlyRate > 0 && termMonths > 0
      ? Math.round(
          (loanPrincipal * (monthlyRate * Math.pow(1 + monthlyRate, termMonths))) /
            (Math.pow(1 + monthlyRate, termMonths) - 1)
        )
      : Math.round(loanPrincipal / Math.max(1, termMonths));

  return {
    vehiclePrice,
    vehiclePriceText: formatVndPrice(vehiclePrice),
    downPaymentPct,
    downPaymentAmount,
    downPaymentText: formatVndPrice(downPaymentAmount),
    loanPrincipal,
    loanPrincipalText: formatVndPrice(loanPrincipal),
    termMonths,
    termYears: Math.round((termMonths / 12) * 10) / 10,
    preferredRateAnnual: annualRate,
    floatingRateAnnual: floatingRate,
    monthlyPayment,
    monthlyPaymentText: `${(monthlyPayment / 1_000_000).toFixed(1)} triệu/tháng`,
  };
};

// ── MongoDB Inventory Query Helper ───────────────────────────────────────────

const escapeRegex = (str = '') => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const queryInventoryForChat = async (filters = {}) => {
  const baseFilter = {
    status: CarStatus.AVAILABLE,
    isActive: true,
  };

  if (filters.vehicleCode) {
    const exactCar = await Car.findOne(
      { ...baseFilter, vehicleCode: filters.vehicleCode },
      CHAT_CAR_PROJECTION
    ).lean();
    if (exactCar) {
      return { matchedCars: [toPublicCar(exactCar)], alternativeCars: [] };
    }
  }

  const criteriaFilter = { ...baseFilter };
  if (filters.brand) {
    criteriaFilter.make = { $regex: `^${escapeRegex(filters.brand)}$`, $options: 'i' };
  }
  if (filters.model) {
    criteriaFilter.model = { $regex: escapeRegex(filters.model), $options: 'i' };
  }
  if (filters.bodyType) {
    criteriaFilter.bodyType = filters.bodyType.toUpperCase();
  }
  if (filters.fuelType) {
    criteriaFilter.fuelType = filters.fuelType.toUpperCase();
  }
  if (filters.transmission) {
    criteriaFilter.transmission = filters.transmission.toUpperCase();
  }
  if (filters.yearMin) {
    criteriaFilter.year = { $gte: Number(filters.yearMin) };
  }
  if (filters.priceMin || filters.priceMax) {
    criteriaFilter.price = {};
    if (filters.priceMin) criteriaFilter.price.$gte = Number(filters.priceMin);
    if (filters.priceMax) criteriaFilter.price.$lte = Number(filters.priceMax);
  }
  if (filters.seats === 7) {
    criteriaFilter.$or = [
      { 'specifications.numberOfSeats': { $gte: 7 } },
      { bodyType: { $in: [BodyType.SUV, BodyType.MPV] } },
    ];
  }

  const sortMap = {
    price_asc: { price: 1 },
    price_desc: { price: -1 },
    mileage_asc: { mileage: 1 },
    year_desc: { year: -1 },
  };
  const sort = sortMap[filters.sortBy] || { createdAt: -1 };

  const matchedRaw = await Car.find(criteriaFilter, CHAT_CAR_PROJECTION)
    .sort(sort)
    .limit(3)
    .lean();

  const matchedCars = matchedRaw.map((car) => toPublicCar({ ...car }));

  if (matchedCars.length > 0) {
    return { matchedCars, alternativeCars: [] };
  }

  // Fallback: fetch up to 3 available cars so visitor still gets real stock options
  const fallbackFilter = { ...baseFilter };
  if (filters.priceMax) {
    fallbackFilter.price = { $lte: Math.round(filters.priceMax * 1.2) };
  }
  let altRaw = await Car.find(fallbackFilter, CHAT_CAR_PROJECTION)
    .sort({ createdAt: -1 })
    .limit(3)
    .lean();

  if (altRaw.length === 0) {
    altRaw = await Car.find(baseFilter, CHAT_CAR_PROJECTION)
      .sort({ createdAt: -1 })
      .limit(3)
      .lean();
  }

  return {
    matchedCars: [],
    alternativeCars: altRaw.map((car) => toPublicCar({ ...car })),
  };
};

// ── UI Actions & Follow-Up Builders ──────────────────────────────────────────

const buildCatalogQueryUrl = (filters = {}) => {
  const params = new URLSearchParams();
  if (filters.brand) params.set('brand', filters.brand);
  if (filters.model) params.set('search', filters.model);
  if (filters.bodyType) params.set('bodyType', filters.bodyType);
  if (filters.fuelType) params.set('fuelType', filters.fuelType);
  if (filters.transmission) params.set('transmission', filters.transmission);
  if (filters.priceMin) params.set('priceMin', String(filters.priceMin));
  if (filters.priceMax) params.set('priceMax', String(filters.priceMax));
  if (filters.yearMin) params.set('yearMin', String(filters.yearMin));
  const qs = params.toString();
  return qs ? `/xe?${qs}` : '/xe';
};

const buildActionsAndFollowUps = ({ intent, filters, matchedCars, alternativeCars, showroom }) => {
  const displayCars = matchedCars.length > 0 ? matchedCars : alternativeCars;
  const firstCar = displayCars[0] || null;
  const firstCarUrl = firstCar
    ? `/xe/${firstCar.vehicleCode || firstCar._id}`
    : null;
  const catalogUrl = buildCatalogQueryUrl(filters);
  const hotlineHref = showroom?.contact?.phoneHref || 'tel:0856098686';
  const hotlineDisplay = showroom?.contact?.phoneDisplay || '0856 098 686';

  switch (intent) {
    case 'LEAD_PHONE':
      return {
        actions: [
          { label: 'Xem kho xe đang sẵn có', to: catalogUrl, primary: true },
          { label: `Gọi ngay ${hotlineDisplay}`, href: hotlineHref },
        ],
        followUps: [
          'Tìm xe SUV dưới 700 triệu',
          'Tính trả góp 5 năm',
          'Quy trình kiểm định CPO 150 điểm',
        ],
      };

    case 'FINANCE_LOAN':
      return {
        actions: [
          { label: 'Mở bảng tính trả góp chi tiết', to: '/mua-xe/tra-gop', primary: true },
          ...(firstCarUrl
            ? [{ label: `Xem xe ${firstCar.make} ${firstCar.model}`, to: firstCarUrl }]
            : [{ label: 'Xem xe đang bán', to: catalogUrl }]),
        ],
        followUps: [
          'Trả trước 20% thì mỗi tháng đóng bao nhiêu?',
          'Thủ tục hồ sơ vay ngân hàng cần gì?',
          'Tìm xe dưới 600 triệu trả góp',
        ],
      };

    case 'TEST_DRIVE_BOOKING':
      return {
        actions: [
          ...(firstCarUrl
            ? [{ label: `Đặt lịch lái thử ${firstCar.make} ${firstCar.model}`, to: firstCarUrl, primary: true }]
            : [{ label: 'Chọn xe để đặt lịch lái thử', to: catalogUrl, primary: true }]),
          { label: 'Liên hệ Showroom', to: '/lien-he' },
        ],
        followUps: [
          'Showroom mở cửa khung giờ nào?',
          'Cần mang giấy tờ gì khi lái thử?',
          'Gợi ý các mẫu xe SUV nổi bật',
        ],
      };

    case 'CPO_WARRANTY':
      return {
        actions: [
          { label: 'Xem quy trình kiểm định CPO', to: '/mua-xe/kiem-dinh-cpo', primary: true },
          { label: 'Chính sách bảo hành & hậu mãi', to: '/mua-xe/bao-hanh-hau-mai' },
        ],
        followUps: [
          'Xem các xe đã có chứng nhận CPO',
          'Chính sách bảo hành động cơ & hộp số',
          'Đặt lịch xem xe trực tiếp tại Showroom',
        ],
      };

    case 'SELL_TRADE_IN':
      return {
        actions: [
          { label: 'Gửi thông tin định giá & bán xe', to: '/ban-xe', primary: true },
          { label: `Gọi Hotline ${hotlineDisplay}`, href: hotlineHref },
        ],
        followUps: [
          'Showroom có hỗ trợ đổi xe bù trừ không?',
          'Xem kho xe để đổi xe nâng đời',
          'Địa chỉ Showroom TrustCar ở đâu?',
        ],
      };

    case 'SHOWROOM_INFO':
      return {
        actions: [
          { label: 'Trang liên hệ & Bản đồ', to: '/lien-he', primary: true },
          { label: `Gọi ${hotlineDisplay}`, href: hotlineHref },
        ],
        followUps: [
          'Đặt lịch lái thử cuối tuần này',
          'Tìm xe dưới 700 triệu',
          'Tư vấn mua xe trả góp',
        ],
      };

    case 'VEHICLE_DETAIL':
    case 'CAR_SEARCH':
      return {
        actions: [
          { label: 'Xem danh sách xe phù hợp', to: catalogUrl, primary: true },
          { label: 'Tính trả góp dự kiến', to: '/mua-xe/tra-gop' },
        ],
        followUps: [
          firstCar
            ? `Tính trả góp mẫu ${firstCar.make} ${firstCar.model} ${firstCar.year}`
            : 'Tính trả góp xe 700 triệu trong 5 năm',
          'Đặt lịch lái thử tại Showroom',
          'Quy trình kiểm định CPO 150 điểm là gì?',
        ],
      };

    default:
      return {
        actions: [
          { label: 'Khám phá kho xe TrustCar', to: '/xe', primary: true },
          { label: 'Tính trả góp', to: '/mua-xe/tra-gop' },
        ],
        followUps: [
          'Tìm SUV 7 chỗ dưới 800 triệu',
          'Tìm xe Sedan tầm 500 - 700 triệu',
          'Tính trả góp 700 triệu trong 5 năm',
          'Quy trình kiểm định CPO 150 điểm',
        ],
      };
  }
};

// ── Deterministic Grounded Reply Builder ─────────────────────────────────────

const describeCarLine = (car) => {
  const name = `${car.make || ''} ${car.model || ''} ${car.variant || ''}`.replace(/\s+/g, ' ').trim();
  const priceText = formatVndPrice(car.price);
  const odoText = Number.isFinite(Number(car.mileage))
    ? `${Number(car.mileage).toLocaleString('vi-VN')} km`
    : 'N/A';
  const cpoTag = car.cpoCertificateId ? ' · Chứng nhận CPO' : '';
  return `• ${name} (${car.year || 'N/A'}) — Giá: ${priceText} · ODO: ${odoText} · Mã: ${car.vehicleCode || ''}${cpoTag}`;
};

const describeFilterSummary = (filters = {}) => {
  const parts = [];
  if (filters.brand) parts.push(`hãng ${filters.brand}`);
  if (filters.model) parts.push(`dòng ${filters.model}`);
  if (filters.bodyType) parts.push(`kiểu dáng ${filters.bodyType}`);
  if (filters.seats) parts.push(`${filters.seats} chỗ`);
  if (filters.fuelType) parts.push(`nhiên liệu ${filters.fuelType}`);
  if (filters.transmission) parts.push(`hộp số ${filters.transmission}`);
  if (filters.yearMin) parts.push(`đời từ ${filters.yearMin}`);
  if (filters.priceLabel) parts.push(`tầm giá ${filters.priceLabel}`);
  return parts.join(', ');
};

export const buildDeterministicReply = ({
  intent,
  filters,
  matchedCars,
  alternativeCars,
  showroom,
  loanEstimate,
  phone,
  leadCode,
}) => {
  const contact = showroom?.contact || {};
  const showroomDisplay = contact.showroomDisplay || 'Showroom TrustCar, Quận 1, TP. Hồ Chí Minh';
  const showroomHours = contact.showroomHours || '08:00 - 20:00 (Thứ 2 - Thứ 7)';
  const phoneDisplay = contact.phoneDisplay || '0856 098 686';
  const testDrive = showroom?.testDrive || { openTime: '09:00', closeTime: '17:00' };

  if (intent === 'LEAD_PHONE') {
    const codeNotice = leadCode ? ` (Mã yêu cầu: ${leadCode})` : '';
    return [
      `Cảm ơn bạn! TrustCar đã ghi nhận số điện thoại ${phone}${codeNotice} vào hệ thống chăm sóc khách hàng.`,
      `Chuyên viên tư vấn của ${contact.showroomName || 'TrustCar'} sẽ liên hệ lại với bạn trong vòng 15 phút để hỗ trợ chi tiết.`,
      matchedCars.length > 0
        ? `Trong lúc chờ đợi, bạn có thể tham khảo các mẫu xe đang sẵn có bên dưới:`
        : `Nếu cần hỗ trợ gấp, bạn có thể gọi trực tiếp Hotline ${phoneDisplay}.`,
    ].join('\n');
  }

  if (intent === 'FINANCE_LOAN' && loanEstimate) {
    const refCar = matchedCars[0] || alternativeCars[0];
    const carLabel = refCar
      ? `cho mẫu ${refCar.make} ${refCar.model} (${refCar.year}) giá ${formatVndPrice(refCar.price)}`
      : `với mức giá xe tham khảo ${loanEstimate.vehiclePriceText}`;

    return [
      `Bảng ước tính trả góp tham khảo ${carLabel}:`,
      `• Trả trước (${loanEstimate.downPaymentPct}%): khoảng ${loanEstimate.downPaymentText}`,
      `• Khoản vay ngân hàng: ${loanEstimate.loanPrincipalText} trong ${loanEstimate.termMonths} tháng (${loanEstimate.termYears} năm)`,
      `• Lãi suất ưu đãi dự kiến: ${loanEstimate.preferredRateAnnual}%/năm (thả nổi tham khảo ~${loanEstimate.floatingRateAnnual}%/năm)`,
      `• Góp hàng tháng ước tính: khoảng ${loanEstimate.monthlyPaymentText}`,
      `Lưu ý: Lãi suất thực tế phụ thuộc vào ngân hàng đối tác và hồ sơ tín dụng. Bạn có thể để lại số điện thoại để chuyên viên gửi bảng tính chi tiết từng tháng.`,
    ].join('\n');
  }

  if (intent === 'TEST_DRIVE_BOOKING') {
    return [
      `Bạn có thể đặt lịch xem xe và lái thử miễn phí trực tiếp tại ${showroomDisplay}:`,
      `• Khung giờ nhận lịch lái thử: ${testDrive.openTime || '09:00'} - ${testDrive.closeTime || '17:00'} (mỗi ca ${testDrive.slotDurationMinutes || 60} phút)`,
      `• Chỉ cần chọn mẫu xe bạn quan tâm, nhấn "Đặt lịch lái thử" trên trang chi tiết xe hoặc để lại Số điện thoại + Khung giờ mong muốn ngay tại đây để TrustCar giữ xe cho bạn!`,
    ].join('\n');
  }

  if (intent === 'CPO_WARRANTY') {
    return [
      `Mọi mẫu xe đạt chuẩn CPO (Certified Pre-Owned) tại TrustCar đều trải qua quy trình kiểm định kỹ thuật 150 hạng mục nghiêm ngặt:`,
      `• Cam kết 3 KHÔNG: Không đâm đụng ảnh hưởng kết cấu khung gầm — Không thủy kích/ngập nước — Không đại tu động cơ, hộp số.`,
      `• Minh bạch ODO thực tế và hồ sơ pháp lý đủ điều kiện sang tên ngay.`,
      `• Đi kèm biên bản kiểm định CPO điện tử và chứng chỉ PDF có mã QR tra cứu công khai trên từng xe.`,
    ].join('\n');
  }

  if (intent === 'SELL_TRADE_IN') {
    return [
      `TrustCar hỗ trợ thu mua xe cũ giá cao và đổi xe nâng đời (Trade-in) bù trừ trực tiếp:`,
      `• Định giá minh bạch, sát giá thị trường chỉ trong 30 phút.`,
      `• Hỗ trợ kiểm tra xe tận nơi, tất toán ngân hàng và sang tên trọn gói.`,
      `• Bạn có thể nhấn "Gửi thông tin định giá & bán xe" bên dưới hoặc để lại dòng xe + năm sản xuất + số điện thoại để bộ phận thu mua liên hệ ngay!`,
    ].join('\n');
  }

  if (intent === 'SHOWROOM_INFO') {
    return [
      `Thông tin liên hệ chính thức của ${contact.showroomName || 'Showroom TrustCar'}:`,
      `• Địa chỉ: ${showroomDisplay}`,
      `• Giờ mở cửa Showroom: ${showroomHours}`,
      `• Khung giờ lái thử: ${testDrive.openTime || '09:00'} - ${testDrive.closeTime || '17:00'}`,
      `• Hotline / Zalo: ${phoneDisplay} — Email: ${contact.email || 'support@trustcar.vn'}`,
    ].join('\n');
  }

  if (intent === 'VEHICLE_DETAIL' || intent === 'CAR_SEARCH') {
    const summaryText = describeFilterSummary(filters);
    if (matchedCars.length > 0) {
      return [
        summaryText
          ? `TrustCar tìm thấy ${matchedCars.length} mẫu xe đang sẵn có phù hợp với tiêu chí (${summaryText}):`
          : `Dưới đây là các mẫu xe đang sẵn sàng giao ngay tại Showroom TrustCar:`,
        ...matchedCars.map(describeCarLine),
        `Bạn muốn xem chi tiết, tính trả góp hay đặt lịch lái thử mẫu xe nào?`,
      ].join('\n');
    }

    if (alternativeCars.length > 0) {
      return [
        summaryText
          ? `Hiện tại trong kho chưa có mẫu xe khớp chính xác 100% với tiêu chí (${summaryText}). Tuy nhiên, TrustCar gợi ý ${alternativeCars.length} mẫu xe chất lượng đang có sẵn gần với nhu cầu của bạn:`
          : `Hiện tại TrustCar đang có sẵn các mẫu xe tiêu biểu sau tại Showroom:`,
        ...alternativeCars.map(describeCarLine),
        `Bạn có thể để lại số điện thoại để TrustCar báo ngay khi có xe đúng cấu hình về kho!`,
      ].join('\n');
    }

    return [
      `Hiện tại hệ thống chưa tìm thấy mẫu xe khớp với tiêu chí ${summaryText || 'bạn vừa nhập'}.`,
      `Bạn vui lòng để lại số điện thoại hoặc mở trang Kho xe để xem toàn bộ danh mục xe mới cập nhật tại TrustCar nhé!`,
    ].join('\n');
  }

  // GREETING or GENERAL
  return [
    `Xin chào! Mình là Trợ lý AI của ${contact.showroomName || 'TrustCar'} — Hệ thống xe đã qua sử dụng đạt chuẩn kiểm định CPO 150 điểm.`,
    `Mình có thể hỗ trợ bạn ngay các thông tin thực tế từ hệ thống:`,
    `• Tìm xe theo hãng, kiểu dáng (SUV, Sedan, Hatchback, Bán tải), ngân sách hoặc số chỗ`,
    `• Ước tính trả góp hàng tháng theo cấu hình lãi suất hiện hành`,
    `• Tra cứu biên bản kiểm định CPO và đặt lịch lái thử tại ${showroomDisplay}`,
    `Bạn đang tìm mẫu xe trong tầm giá bao nhiêu để mình lọc ngay từ kho xe nhé?`,
  ].join('\n');
};

// ── Conversation & Message Persistence ───────────────────────────────────────

const normalizeConversationCode = (sessionId) => {
  const cleaned = String(sessionId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 80);
  if (cleaned.length >= 6) return cleaned;
  return `tc-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

const persistChatTurn = async ({
  conversationCode,
  userMessage,
  aiReply,
  customerName,
  phone,
  leadId,
  summaryText,
}) => {
  try {
    const now = new Date();
    const updatePatch = {
      lastMessageAt: now,
    };
    if (customerName) updatePatch.contactName = customerName;
    if (phone) updatePatch.contactPhone = phone;
    if (leadId) updatePatch.leadId = leadId;
    if (summaryText) {
      updatePatch.summary = summaryText;
      updatePatch.summaryUpdatedAt = now;
      updatePatch.lastSummarizedMessageAt = now;
    }

    const conversation = await ChatConversation.findOneAndUpdate(
      { conversationCode },
      {
        $set: updatePatch,
        $setOnInsert: {
          conversationCode,
          startedAt: now,
          status: ConversationStatus.OPEN,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    if (conversation?._id) {
      await ChatMessage.insertMany([
        {
          conversationId: conversation._id,
          senderType: SenderType.CUSTOMER,
          content: userMessage,
          sentAt: now,
        },
        {
          conversationId: conversation._id,
          senderType: SenderType.AI,
          content: aiReply,
          sentAt: new Date(now.getTime() + 1),
        },
      ]);
    }
    return conversation;
  } catch {
    // Non-fatal: chat replies must still succeed if DB write encounters transient issues
    return null;
  }
};

// ── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Processes a public chat message, queries real inventory & settings,
 * optionally calls LLM with grounded data, persists conversation & lead,
 * and returns a structured response for `ChatWidget.jsx`.
 *
 * @param {object} payload
 * @param {string} payload.message
 * @param {string} [payload.sessionId]
 * @param {Array<{role: string, content: string}>} [payload.history]
 * @param {string} [payload.customerName]
 * @param {string} [payload.customerPhone]
 * @param {object} [context] - { ipAddress, userAgent, llmOptions }
 */
export const processPublicChatMessage = async (payload = {}, context = {}) => {
  const message = String(payload.message || '').trim();
  const history = Array.isArray(payload.history) ? payload.history : [];
  const conversationCode = normalizeConversationCode(payload.sessionId);

  const analysis = analyzeConversationTurn(message, history);
  const phone = analysis.phone || (payload.customerPhone ? normalizePhone(payload.customerPhone) : null);
  const validPhone = phone && isValidVietnamesePhone(phone) ? phone : null;
  const customerName =
    payload.customerName?.trim() ||
    analysis.customerName ||
    'Khách hàng Chatbot';

  // Fetch showroom settings, loan settings, and matching cars in parallel
  const shouldQueryCars =
    analysis.hasCarCriteria ||
    ['CAR_SEARCH', 'VEHICLE_DETAIL', 'FINANCE_LOAN', 'TEST_DRIVE_BOOKING', 'GREETING', 'LEAD_PHONE'].includes(
      analysis.intent
    );

  const [showroom, loanSettings, inventoryResult] = await Promise.all([
    getBaseSettings().catch(() => null),
    getLoanSettings().catch(() => null),
    shouldQueryCars
      ? queryInventoryForChat(analysis.filters).catch(() => ({ matchedCars: [], alternativeCars: [] }))
      : Promise.resolve({ matchedCars: [], alternativeCars: [] }),
  ]);

  const { matchedCars, alternativeCars } = inventoryResult;
  const displayCars = matchedCars.length > 0 ? matchedCars : alternativeCars;

  // Compute loan estimate if relevant
  const referenceCarPrice = displayCars[0]?.price || null;
  const loanEstimate =
    analysis.intent === 'FINANCE_LOAN' || /\b(tra gop|vay|moi thang)\b/.test(analysis.normalizedMessage)
      ? computeLoanEstimate(message, loanSettings || {}, referenceCarPrice)
      : null;

  // Capture CRM Lead if visitor provided a valid Vietnamese phone number
  let capturedLead = null;
  if (validPhone) {
    try {
      const targetVehicleCode =
        analysis.filters.vehicleCode || displayCars[0]?.vehicleCode || undefined;
      capturedLead = await createPublicEnquiry(
        {
          fullName: customerName,
          phone: validPhone,
          message: `[AI Chatbot - ${conversationCode}] ${message}`,
          vehicleCode: targetVehicleCode,
          pagePath: '/chat',
        },
        {
          ipAddress: context.ipAddress || null,
          userAgent: context.userAgent || null,
        }
      );
    } catch {
      // Never block chat response if lead creation fails (e.g., vehicleCode not found)
      capturedLead = null;
    }
  }

  // Build deterministic baseline response + actions + follow-ups
  const deterministicReply = buildDeterministicReply({
    intent: analysis.intent,
    filters: analysis.filters,
    matchedCars,
    alternativeCars,
    showroom,
    loanEstimate,
    phone: validPhone,
    leadCode: capturedLead?.leadCode || null,
  });

  const { actions, followUps: defaultFollowUps } = buildActionsAndFollowUps({
    intent: analysis.intent,
    filters: analysis.filters,
    matchedCars,
    alternativeCars,
    showroom,
  });

  // Attempt Hybrid AI LLM enrichment grounded strictly on real DB context
  const groundedContext = {
    intent: analysis.intent,
    extractedFilters: analysis.filters,
    matchedCars: matchedCars.map((c) => ({
      vehicleCode: c.vehicleCode,
      make: c.make,
      model: c.model,
      variant: c.variant,
      year: c.year,
      priceVnd: c.price,
      priceFormatted: formatVndPrice(c.price),
      mileageKm: c.mileage,
      bodyType: c.bodyType,
      fuelType: c.fuelType,
      transmission: c.transmission,
      cpoCertified: Boolean(c.cpoCertificateId),
    })),
    alternativeCars:
      matchedCars.length === 0
        ? alternativeCars.map((c) => ({
            vehicleCode: c.vehicleCode,
            make: c.make,
            model: c.model,
            variant: c.variant,
            year: c.year,
            priceVnd: c.price,
            priceFormatted: formatVndPrice(c.price),
            mileageKm: c.mileage,
            bodyType: c.bodyType,
            fuelType: c.fuelType,
            transmission: c.transmission,
            cpoCertified: Boolean(c.cpoCertificateId),
          }))
        : [],
    loanSettings: loanSettings || undefined,
    loanEstimate: loanEstimate || undefined,
    showroom: showroom
      ? {
          name: showroom.contact?.showroomName,
          address: showroom.contact?.address,
          phone: showroom.contact?.phoneDisplay,
          hours: showroom.contact?.showroomHours,
          testDriveHours: `${showroom.testDrive?.openTime || '09:00'} - ${showroom.testDrive?.closeTime || '17:00'}`,
        }
      : undefined,
    leadCaptured: validPhone
      ? { phone: validPhone, leadCode: capturedLead?.leadCode || null }
      : undefined,
  };

  const llmResult = await generateGroundedChatCompletion(
    {
      message,
      history,
      groundedContext,
    },
    context.llmOptions || {}
  );

  const finalReply = llmResult?.reply || deterministicReply;
  const finalFollowUps =
    llmResult?.followUps && llmResult.followUps.length > 0
      ? llmResult.followUps
      : defaultFollowUps;

  // Decide whether to attach car cards to the chat bubble
  const shouldAttachCarCards = [
    'CAR_SEARCH',
    'VEHICLE_DETAIL',
    'FINANCE_LOAN',
    'TEST_DRIVE_BOOKING',
    'LEAD_PHONE',
  ].includes(analysis.intent);

  const carsForCards = shouldAttachCarCards ? displayCars.slice(0, 3) : [];

  // Persist conversation and messages to MongoDB
  const summaryParts = [`Intent: ${analysis.intent}`];
  const filterDesc = describeFilterSummary(analysis.filters);
  if (filterDesc) summaryParts.push(`Tiêu chí: ${filterDesc}`);
  if (validPhone) summaryParts.push(`SĐT: ${validPhone}`);

  await persistChatTurn({
    conversationCode,
    userMessage: message,
    aiReply: finalReply,
    customerName: validPhone || analysis.customerName ? customerName : null,
    phone: validPhone,
    leadId: null,
    summaryText: summaryParts.join(' | '),
  });

  return {
    conversationCode,
    sessionId: conversationCode,
    intent: analysis.intent,
    reply: finalReply,
    cars: carsForCards,
    actions,
    followUps: finalFollowUps,
    leadCaptured: validPhone
      ? {
          phone: validPhone,
          leadCode: capturedLead?.leadCode || null,
        }
      : null,
    source: llmResult ? 'hybrid-llm' : 'hybrid-grounded',
  };
};

export default {
  processPublicChatMessage,
  analyzeConversationTurn,
  extractEntitiesFromSingleText,
  parsePriceRangeFromText,
  computeLoanEstimate,
  buildDeterministicReply,
  normalizeVietnameseText,
  formatVndPrice,
};

