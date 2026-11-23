/**
 * @file newCarPriceEstimator.js
 * @description Resolves or estimates the reference new-car on-the-road price (VND)
 * so every Car document in MongoDB stores `newCarPrice` (and `marketPrice`) for
 * public detail savings comparison.
 */

const MILLION = 1_000_000;

const REFERENCE_NEW_PRICES_MILLION = [
  { match: /everest.*titanium.*4x4/i, price: 1620 },
  { match: /everest.*titanium.*4x2/i, price: 1450 },
  { match: /everest.*sport/i, price: 1320 },
  { match: /everest/i, price: 1420 },
  { match: /territory.*titanium\s*x/i, price: 995 },
  { match: /territory.*titanium/i, price: 925 },
  { match: /territory/i, price: 910 },
  { match: /ranger.*wildtrak/i, price: 1045 },
  { match: /ranger.*xls/i, price: 765 },
  { match: /ranger/i, price: 820 },
  { match: /ecosport/i, price: 695 },
  { match: /santa\s*fe.*(diesel|dầu)/i, price: 1385 },
  { match: /santa\s*fe/i, price: 1310 },
  { match: /tucson.*turbo/i, price: 1055 },
  { match: /tucson/i, price: 980 },
  { match: /accent/i, price: 595 },
  { match: /\bi10\b/i, price: 485 },
  { match: /3008/i, price: 1220 },
  { match: /camry.*2\.5q/i, price: 1520 },
  { match: /camry/i, price: 1380 },
  { match: /hilux/i, price: 835 },
  { match: /mazda\s*3/i, price: 725 },
  { match: /cx-?5.*2\.5/i, price: 1090 },
  { match: /cx-?5/i, price: 960 },
  { match: /lux\s*sa2\.0/i, price: 1580 },
  { match: /lux\s*a2\.0/i, price: 1260 },
  { match: /vf\s*3/i, price: 335 },
  { match: /c300.*amg|c-class.*c300/i, price: 2150 },
  { match: /c250|c-class.*c250/i, price: 1920 },
  { match: /c-class/i, price: 1890 },
  { match: /sonet/i, price: 679 },
];

/**
 * Estimates the brand-new on-the-road price (in VND) for a car record.
 *
 * @param {object} car - Car data ({ make, model, variant, fuelType, year, mileage, price, newCarPrice, marketPrice })
 * @returns {number|null}
 */
export const resolveNewCarPrice = (car = {}) => {
  const usedPrice = Number(car.price ?? car.listedPrice);
  if (!Number.isFinite(usedPrice) || usedPrice <= 0) return null;

  const explicit = Number(car.newCarPrice ?? car.marketPrice);
  if (Number.isFinite(explicit) && explicit > usedPrice) {
    return Math.round(explicit);
  }

  const fullName = [car.make, car.model, car.variant, car.fuelType]
    .filter(Boolean)
    .join(' ');
  const matched = REFERENCE_NEW_PRICES_MILLION.find((item) => item.match.test(fullName));
  if (matched && matched.price * MILLION >= usedPrice * 1.08) {
    return matched.price * MILLION;
  }

  const currentYear = new Date().getFullYear();
  const carYear = Number(car.year) || currentYear;
  const ageYears = Math.max(0, Math.min(12, currentYear - carYear));
  const mileageKm = Math.max(0, Number(car.mileage) || 0);
  const multiplier = Math.min(
    1.95,
    1.14 + ageYears * 0.055 + Math.min(0.12, (mileageKm / 20000) * 0.015)
  );

  return Math.round((usedPrice * multiplier) / (5 * MILLION)) * (5 * MILLION);
};

export default { resolveNewCarPrice };
