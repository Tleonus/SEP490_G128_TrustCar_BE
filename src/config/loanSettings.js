/**
 * @file loanSettings.js
 * @description Canonical loan calculator configuration (KAN-63).
 *
 * PLACEHOLDER VALUES — the rates below are illustrative only and have NOT been
 * confirmed by a partner bank. They exist so the calculator page has something
 * to render before finance signs off; the admin PUT replaces them. Do not cite
 * these numbers in any customer-facing copy as real offers.
 */

export const LOAN_SETTINGS_KEY = 'LOAN_CONFIG';
export const LOAN_SETTINGS_GROUP = 'finance';

export const LOAN_FIELDS = Object.freeze([
  'preferredRateAnnual',
  'floatingRateAnnual',
  'minDownPaymentPct',
  'maxTermMonths',
  'minTermMonths',
]);

/**
 * @returns {object} a fresh defaults object (never frozen, so callers can merge).
 */
export const getDefaultLoanSettings = () => ({
  preferredRateAnnual: 8.5,   // % per year, placeholder — pending partner bank confirmation
  floatingRateAnnual: 10.5,   // % per year, placeholder — pending partner bank confirmation
  minDownPaymentPct: 20,      // % of vehicle price
  minTermMonths: 12,
  maxTermMonths: 84,
});

/**
 * Keeps only the five contract fields, in a stable order.
 * @param {object} value
 * @returns {object}
 */
export const toPublicLoanSettings = (value = {}) => {
  const dto = {};
  LOAN_FIELDS.forEach((field) => { dto[field] = value[field]; });
  return dto;
};
