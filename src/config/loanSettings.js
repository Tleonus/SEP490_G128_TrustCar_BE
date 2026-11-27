/**
 * @file loanSettings.js
 * @description Canonical loan calculator configuration (KAN-63).
 *
 * The five scalar fields feed the chatbot loan estimate (min/max term are derived
 * from `termOptions`). `termOptions` and `downPaymentOptions` are the choices the
 * customer sees on the calculator. `banks` (admin screen
 * "Lãi suất trả góp") feeds the public installment calculator. Each bank has a
 * promoRate (used for the whole term by the calculator) and optional loan
 * conditions: maxLoanPct (% giá xe), minLoanAmount (đồng), minTermMonths /
 * maxTermMonths. There is no promo period or post-promotion
 * (floating) rate: banks do not publish it in advance.
 * Exactly one bank is the showroom partner; when banks are saved,
 * `preferredRateAnnual` follows the partner bank's promo rate.
 *
 * Default figures were checked on each bank's official web page on 27/11/2026
 * (dates in `sourceDate`). `null` = the bank does not publish that number.
 */

export const LOAN_SETTINGS_KEY = 'LOAN_CONFIG';
export const LOAN_SETTINGS_GROUP = 'finance';

export const LOAN_FIELDS = Object.freeze([
  'preferredRateAnnual',
  'floatingRateAnnual',
  'minDownPaymentPct',
  'maxTermMonths',
  'minTermMonths',
  'termOptions',
  'downPaymentOptions',
  'banks',
]);

export const BANK_FIELDS = Object.freeze([
  'id', 'name', 'isPartner', 'active', 'promoRate',
  'maxLoanPct', 'minLoanAmount', 'minTermMonths', 'maxTermMonths', 'note', 'cars', 'sourceUrl', 'sourceDate',
]);

export const MAX_BANKS = 10;

const NO_CONDITIONS = { maxLoanPct: null, minLoanAmount: null, minTermMonths: null, maxTermMonths: null };

const DEFAULT_BANKS = [
  {
    ...NO_CONDITIONS,
    id: 'TPBANK', name: 'TPBank', isPartner: true, active: true,
    promoRate: 8.2, maxTermMonths: 96,
    note: 'Có gói cố định 6–24 tháng (8,2–11,2%).',
    cars: 'Liên kết showroom',
    sourceUrl: 'https://tpb.vn/tin-tuc/tin-tpbank/tpbank-tung-chuoi-uu-dai-lai-suat-8000-ty-dong-danh-cho-khach-hang-doanh-nghiep-sme-va-khach-hang-ca-nhan',
    sourceDate: '26/08/2026',
  },
  {
    ...NO_CONDITIONS,
    id: 'MSB', name: 'MSB', isPartner: false, active: false,
    promoRate: 7.5, maxLoanPct: 70, maxTermMonths: 96,
    note: '',
    cars: 'Xe cũ: vay 70%, 8 năm',
    sourceUrl: 'https://www.msb.com.vn/ve-chung-toi/tin-tuc-va-su-kien/kien-thuc-xu-huong/vay-the-chap-o-to/',
    sourceDate: '19/11/2026',
  },
  {
    ...NO_CONDITIONS,
    id: 'PVCOMBANK', name: 'PVcomBank', isPartner: false, active: true,
    promoRate: 9.5, maxLoanPct: 80, maxTermMonths: 72,
    note: '',
    cars: 'Xe mới và xe cũ',
    sourceUrl: 'https://www.pvcombank.com.vn/san-pham/ca-nhan/san-pham-vay/vay-mua-o-to',
    sourceDate: 'Không ghi ngày',
  },
  {
    ...NO_CONDITIONS,
    id: 'HLBANK', name: 'Hong Leong Bank', isPartner: false, active: true,
    promoRate: 10.59,
    maxLoanPct: 80, minLoanAmount: 300_000_000, minTermMonths: 48, maxTermMonths: 60,
    note: 'Gói 2 năm; gói 1 năm: 9,99%.',
    cars: 'Chỉ xe mới',
    sourceUrl: 'https://www.hlbank.com.vn/vi/personal-banking/loan/auto-loan.html',
    sourceDate: '15/10/2026',
  },
];

/**
 * @returns {object} a fresh defaults object (never frozen, so callers can merge).
 */
export const getDefaultLoanSettings = () => ({
  preferredRateAnnual: 8.2,   // follows the partner bank (TPBank) promo rate
  floatingRateAnnual: 10.5,   // chatbot reference only; the calculator does not use a floating rate
  minDownPaymentPct: 30,      // % of vehicle price (max loan 70 %)
  minTermMonths: 12,
  maxTermMonths: 84,
  termOptions: [12, 24, 36, 48, 60, 72, 84], // loan terms the customer can pick (months)
  downPaymentOptions: [30, 40, 50, 70],     // quick down-payment buttons (% of price)
  banks: DEFAULT_BANKS.map((bank) => ({ ...bank })),
});

/** Sorted unique integers. */
export const sortedUnique = (values) => [...new Set(values)].sort((a, b) => a - b);

/**
 * Term options for a record saved before `termOptions` existed: multiples of
 * 12 months within [min, max]; none → [max].
 */
export const termsInRange = (minTermMonths, maxTermMonths) => {
  const terms = [];
  for (let months = 12; months <= maxTermMonths; months += 12) if (months >= minTermMonths) terms.push(months);
  return terms.length > 0 ? terms : [maxTermMonths];
};

/** Keeps only the known bank fields, in a stable order. */
export const toPublicBank = (bank = {}) => {
  const dto = {};
  BANK_FIELDS.forEach((field) => { dto[field] = bank[field] ?? null; });
  return dto;
};

/**
 * Keeps only the contract fields, in a stable order.
 * @param {object} value
 * @returns {object}
 */
export const toPublicLoanSettings = (value = {}) => {
  const dto = {};
  LOAN_FIELDS.forEach((field) => { dto[field] = value[field]; });
  if (Array.isArray(dto.banks)) dto.banks = dto.banks.map(toPublicBank);
  return dto;
};

/**
 * Chatbot promo rate derived from the partner bank. `floatingRateAnnual` is not
 * derived: banks do not publish their post-promotion rate in advance.
 * @param {object[]} banks
 * @returns {{ preferredRateAnnual: number }|null}
 */
export const partnerRates = (banks) => {
  const partner = Array.isArray(banks) ? banks.find((bank) => bank.isPartner) : null;
  return partner ? { preferredRateAnnual: partner.promoRate } : null;
};
