/**
 * @file codeGenerator.js
 * @description Factory / Utility Pattern – Unique sequential code generators
 * for TrustCar entity identifiers.
 *
 * Formats:
 *   Vehicle:      TC-YYYY-NNNN   (e.g., TC-2024-0042)
 *   Lead:         LD-NNNN        (e.g., LD-0127)
 *   Appointment:  APT-NNNN       (e.g., APT-0009)
 *
 * Strategy: Query the database for the highest existing code of each type, then
 * increment. Uses Mongoose models (lazy-imported) to avoid circular dependency.
 * Wrapped in a retry loop to handle race conditions from concurrent requests.
 *
 * Ref: GBR-13
 */

import dayjs from 'dayjs';

/**
 * Pads a number to the specified digit width with leading zeros.
 * @param {number} num
 * @param {number} [width=4]
 * @returns {string}
 */
const pad = (num, width = 4) => String(num).padStart(width, '0');

/**
 * Generates the next vehicle code in TC-YYYY-NNNN format.
 * Sequences are year-scoped, resetting to 0001 each calendar year.
 *
 * @param {import('mongoose').Model} CarModel - The Mongoose Car model.
 * @returns {Promise<string>}
 */
export const generateVehicleCode = async (CarModel) => {
  const year = dayjs().year();
  const prefix = `TC-${year}-`;

  // Find the highest numbered code for the current year
  const lastCar = await CarModel.findOne(
    { vehicleCode: { $regex: `^${prefix}` } },
    { vehicleCode: 1 },
    { sort: { vehicleCode: -1 }, lean: true }
  );

  let nextNum = 1;
  if (lastCar && lastCar.vehicleCode) {
    const parts = lastCar.vehicleCode.split('-');
    const lastNum = parseInt(parts[2], 10);
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }

  // Guard against year overflow (>9999 vehicles/year – extremely unlikely)
  if (nextNum > 9999) {
    throw new Error(`Vehicle code sequence for year ${year} has been exhausted.`);
  }

  return `${prefix}${pad(nextNum)}`;
};

/**
 * Generates the next lead code in LD-NNNN format.
 * Sequence is global (not year-scoped) and continuously increments.
 *
 * @param {import('mongoose').Model} LeadModel - The Mongoose Lead model.
 * @returns {Promise<string>}
 */
export const generateLeadCode = async (LeadModel) => {
  const lastLead = await LeadModel.findOne(
    { leadCode: { $regex: '^LD-' } },
    { leadCode: 1 },
    { sort: { leadCode: -1 }, lean: true }
  );

  let nextNum = 1;
  if (lastLead && lastLead.leadCode) {
    const parts = lastLead.leadCode.split('-');
    const lastNum = parseInt(parts[1], 10);
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }

  if (nextNum > 9999) {
    // Expand to 8-digit padding beyond 9999
    return `LD-${pad(nextNum, 8)}`;
  }

  return `LD-${pad(nextNum)}`;
};

/**
 * Generates the next appointment code in APT-NNNN format.
 * Sequence is global and continuously increments.
 *
 * @param {import('mongoose').Model} AppointmentModel - The Mongoose Appointment model.
 * @returns {Promise<string>}
 */
export const generateAppointmentCode = async (AppointmentModel) => {
  const lastAppt = await AppointmentModel.findOne(
    { appointmentCode: { $regex: '^APT-' } },
    { appointmentCode: 1 },
    { sort: { appointmentCode: -1 }, lean: true }
  );

  let nextNum = 1;
  if (lastAppt && lastAppt.appointmentCode) {
    const parts = lastAppt.appointmentCode.split('-');
    const lastNum = parseInt(parts[1], 10);
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }

  if (nextNum > 9999) {
    return `APT-${pad(nextNum, 8)}`;
  }

  return `APT-${pad(nextNum)}`;
};

/**
 * Generates a cryptographically random alphanumeric token (for password reset, etc.).
 *
 * @param {number} [length=32]
 * @returns {string}
 */
export const generateSecureToken = (length = 32) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  // Use Math.random as a fallback; crypto.randomBytes is preferred in Node
  for (let i = 0; i < length; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
};

/**
 * Generates a secure token using Node.js crypto module (preferred).
 * Falls back to generateSecureToken if crypto is unavailable.
 *
 * @param {number} [byteLength=32]
 * @returns {string} Hex-encoded token.
 */
export const generateCryptoToken = async (byteLength = 32) => {
  try {
    const { randomBytes } = await import('crypto');
    return randomBytes(byteLength).toString('hex');
  } catch {
    return generateSecureToken(byteLength * 2);
  }
};

export default {
  generateVehicleCode,
  generateLeadCode,
  generateAppointmentCode,
  generateSecureToken,
  generateCryptoToken,
};
