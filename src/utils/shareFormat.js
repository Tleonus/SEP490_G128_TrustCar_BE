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

export default { formatSharePrice, resolveShareImage };
