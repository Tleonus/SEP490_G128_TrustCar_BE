/**
 * @file captionGuard.js
 * @description Post-check for generated captions (KAN-68 §4).
 *
 * A caption about a car is a public claim about that car, so any number it
 * states must come from the vehicle record. This module extracts every number
 * from a caption and discards the caption if one of them is not in the fact
 * sheet. Strings without numbers (the majority of what a caption says) always
 * pass — the check is deliberately blind to adjectives and only guards figures.
 *
 * Both sides are normalised before comparison, so the model may write "40.000 km"
 * or "40000 km" and either matches a stored 40000.
 */

import { factsTitle } from './captionFacts.js';

/** Number-like tokens: 1.234, 40 000, 0.52, 520, 2.0, 1,5 */
const NUMBER_TOKEN = /\d+(?:[.,]\d+)*/g;

/** Splits a token into every plausible reading of it. */
const readings = (token) => {
  const out = new Set();
  const plain = token.replace(/[.,]/g, '');
  out.add(plain);

  // "40.000" / "40,000" is a thousand separator, not a decimal point.
  const grouped = /^\d{1,3}([.,]\d{3})+$/.test(token);
  if (grouped) out.add(plain);

  // "0.52" is half a billion dong; "1.25" is one and a quarter.
  // No per-part readings: splitting "2.0" into "2" and "0" would let "máy 2.0L"
  // pass as soon as any fact happens to render a 0 or a 2 (price / 1e9 does).
  if (/^\d+[.,]\d+$/.test(token)) out.add(token.replace(',', '.'));

  return [...out];
};

/**
 * Every number a caption is allowed to state, derived from the facts.
 * Price and mileage are added in each form a Vietnamese writer would use.
 * @param {object} facts - from buildCaptionFacts
 * @returns {Set<string>}
 */
export const allowedNumbers = (facts) => {
  const allowed = new Set();
  const add = (value) => {
    if (value === null || value === undefined || value === '') return;
    String(value).split(/[^\d.]+/).filter(Boolean).forEach((part) => {
      readings(part.replace(/\.$/, '')).forEach((r) => allowed.add(r));
    });
  };

  add(facts.year);
  add(facts.mileage);
  add(facts.criteriaCount);

  // Price appears as VND, as millions and as billions in ordinary copy.
  const price = Number(facts.price);
  if (Number.isFinite(price) && price > 0) {
    add(price);
    const millions = Math.round(price / 1e6);
    add(millions);
    add(price / 1e6);
    if (price >= 1e9) {
      add(price / 1e9);
      add(Math.round(price / 1e8) / 10);
    }
    // "chỉ từ 520 triệu" → "520"; "0,52 tỷ" → "0,52".
    add(Number((price / 1e9).toFixed(2)));
  }

  // Digits inside the model name ("Vios 1.5G") and the certificate code.
  add(facts.variant);
  add(facts.cpoCode);
  add(String(factsTitle(facts)).replace(/[A-Za-zÀ-ỹ]+/g, ' '));

  return allowed;
};

/**
 * @param {string} caption
 * @returns {string[]} the number tokens the caption states
 */
export const numbersIn = (caption) => String(caption ?? '').match(NUMBER_TOKEN) || [];

/**
 * True when every number in the caption is traceable to the fact sheet.
 * @param {string} caption
 * @param {Set<string>} allowed
 */
export const isGrounded = (caption, allowed) =>
  numbersIn(caption).every((token) => readings(token).some((r) => allowed.has(r)));

/**
 * Keeps only captions whose numbers all come from the facts.
 * @param {string[]} captions
 * @param {Set<string>} allowed
 * @returns {{ kept: string[], dropped: string[] }}
 */
export const filterGrounded = (captions, allowed) => {
  const kept = [];
  const dropped = [];
  (captions || []).forEach((caption) => {
    const text = String(caption ?? '').trim();
    if (!text) return;
    (isGrounded(text, allowed) ? kept : dropped).push(text);
  });
  return { kept, dropped };
};

export default { allowedNumbers, numbersIn, isGrounded, filterGrounded };
