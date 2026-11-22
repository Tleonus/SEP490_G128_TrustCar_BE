/**
 * @file shareFormat.js
 * @description Shared formatting for anything that presents a car to the public:
 * share previews (KAN-64) and marketing captions (KAN-68). Lives in utils so the
 * two services do not import each other.
 */

/**
 * @param {number} price - Price in VND.
 * @returns {string} Compact Vietnamese price, e.g. "850 triệu" or "1,2 tỷ".
 */
export const formatSharePrice = (price) => {
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1_000_000_000) {
    const ty = value / 1_000_000_000;
    return `${ty.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ`;
  }
  return `${Math.round(value / 1_000_000).toLocaleString('vi-VN')} triệu`;
};

/**
 * A price read as a "tầm" band, the way Vietnamese car ads talk about money.
 *
 * The figure is a bound derived from the stored price, never a second price.
 * It is always rounded DOWN to the nearest 50 triệu, which makes the phrase
 * true by construction: 615 triệu → "tầm 600 triệu" (the car is in the
 * 600–650 triệu segment), 520 triệu → "tầm 500 triệu". Rounding down can never
 * overstate what the buyer has to pay.
 *
 * Below 50 triệu the downward band would be 0, so that case rounds UP and says
 * "dưới", which is still true ("dưới 50 triệu" for a 35 triệu car).
 *
 * @param {number} price - Price in VND.
 * @returns {{ kind: 'duoi'|'tam', valueMillion: number }|null}
 */
export const priceBand = (price) => {
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) return null;

  const exactMillion = value / 1_000_000;
  const lower = Math.floor(exactMillion / 50) * 50;
  if (lower > 0) return { kind: 'tam', valueMillion: lower };

  return { kind: 'duoi', valueMillion: 50 };
};

/**
 * @param {number} price - Price in VND.
 * @returns {string} e.g. "tầm 600 triệu", "dưới 650 triệu" or "" when the price is missing.
 */
export const formatSharePriceBand = (price) => {
  const band = priceBand(price);
  if (!band) return '';
  const amount = band.valueMillion.toLocaleString('vi-VN');
  return band.kind === 'duoi' ? `dưới ${amount} triệu` : `tầm ${amount} triệu`;
};

/**
 * Absolute URL of the image a crawler or a social post should show. socialImage
 * (KAN-65) wins when present; otherwise the image flagged isPrimary, then any
 * image. socialImage.publicId is intentionally never read here.
 *
 * @param {object} car
 * @returns {string|null}
 */
export const resolveShareImage = (car) => {
  const socialUrl = car.socialImage?.url;
  if (typeof socialUrl === 'string' && socialUrl.trim()) return socialUrl.trim();

  const images = Array.isArray(car.images) ? car.images : [];
  const chosen = images.find((image) => image.isPrimary) || images[0];
  return chosen?.url?.trim() || null;
};

export default { formatSharePrice, formatSharePriceBand, priceBand, resolveShareImage };
