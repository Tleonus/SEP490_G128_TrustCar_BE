/**
 * @file shareCarService.js
 * @description Builds the Open Graph preview for a vehicle share link (KAN-64).
 *
 * Facebook and Zalo crawlers do not execute JavaScript, so the SPA page at
 * /xe/:code renders a blank preview. This service supplies the data for a
 * server-rendered HTML page that carries the OG tags and then redirects the
 * human visitor to the front-end detail page.
 *
 * Only AVAILABLE vehicles are shareable (GBR-11). The social image prefers
 * car.socialImage.url (KAN-65, owned by another assignee — the field may not
 * exist yet) and falls back to the primary gallery image.
 */

import { formatSharePrice, resolveShareImage } from '../utils/shareFormat.js';
import Car from '../models/Car.js';
import { CarStatus } from '../constants/appConstants.js';
import { frontendUrl } from '../utils/emailLayout.js';

const VEHICLE_CODE = /^TC-\d{4}-\d{4}$/i;

// Labels shown to Vietnamese readers in the preview description.
const TRANSMISSION_LABEL = { MANUAL: 'số sàn', AUTOMATIC: 'số tự động', CVT: 'vô cấp', DCT: 'ly hợp kép' };
const FUEL_LABEL = { GASOLINE: 'xăng', DIESEL: 'dầu', HYBRID: 'hybrid', ELECTRIC: 'điện', LPG: 'gas' };



const buildDescription = (car) => {
  const parts = [];
  if (car.mileage > 0) parts.push(`${Number(car.mileage).toLocaleString('vi-VN')} km`);
  if (car.transmission) parts.push(TRANSMISSION_LABEL[car.transmission] || car.transmission);
  if (car.fuelType) parts.push(FUEL_LABEL[car.fuelType] || car.fuelType);
  if (car.cpoCertificateId) parts.push(`CPO ${car.cpoCertificateId}`);
  return parts.join(' · ');
};

/**
 * Looks up a shareable vehicle and returns the preview payload.
 * Throws a 404-shaped error when the code is malformed or the car is not
 * currently AVAILABLE, so the controller can render the "unavailable" page.
 *
 * @param {string} code - vehicleCode (TC-YYYY-NNNN).
 * @returns {Promise<object>}
 */
export const getSharePreview = async (code) => {
  if (!VEHICLE_CODE.test(code || '')) {
    const error = new Error('Vehicle not found.');
    error.statusCode = 404;
    throw error;
  }

  const car = await Car.findOne(
    { vehicleCode: code.toUpperCase(), status: CarStatus.AVAILABLE, isActive: true },
    {
      vehicleCode: 1,
      make: 1,
      model: 1,
      variant: 1,
      year: 1,
      price: 1,
      mileage: 1,
      transmission: 1,
      fuelType: 1,
      cpoCertificateId: 1,
      images: 1,
      socialImage: 1,
    }
  ).lean();

  if (!car) {
    const error = new Error('Vehicle not found or is not currently available.');
    error.statusCode = 404;
    throw error;
  }

  const price = formatSharePrice(car.price);
  const name = [car.make, car.model, car.variant].filter(Boolean).join(' ');
  const title = [name, car.year, price].filter(Boolean).join(' ');

  return {
    vehicleCode: car.vehicleCode,
    title: title || 'TrustCar',
    description: buildDescription(car) || 'Xe đã qua kiểm định tại TrustCar',
    image: resolveShareImage(car),
    shareUrl: sharePageUrl(car.vehicleCode),
    redirectUrl: `${frontendUrl()}/xe/${encodeURIComponent(car.vehicleCode)}`,
  };
};

/**
 * Absolute URL of the share page itself, used for og:url. Crawlers resolve
 * relative og:url against the request host, so the request host is the
 * reliable source; SHARE_BASE_URL overrides it when the API sits behind a
 * proxy that does not forward the public host.
 *
 * @param {string} code
 * @param {import('express').Request} [req]
 * @returns {string}
 */
export const sharePageUrl = (code, req) => {
  const base = (process.env.SHARE_BASE_URL || '').replace(/\/+$/, '');
  if (base) return `${base}/share/car/${code}`;
  if (req) return `${req.protocol}://${req.get('host')}/share/car/${code}`;
  return `/share/car/${code}`;
};

export default { getSharePreview, resolveShareImage, formatSharePrice, sharePageUrl };
