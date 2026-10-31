// src/services/inspectionService.js
/**
 * @file inspectionService.js
 * @description Business logic for Car Inspection Workflow & Approval Engine (5 CPO Criteria).
 */

import crypto from 'crypto';
import dayjs from 'dayjs';
import Car from '../models/Car.js';
import InspectionRecord from '../models/InspectionRecord.js';
import { CarStatus } from '../constants/appConstants.js';
import { AppError } from '../utils/apiResponse.js';

/**
 * Evaluates 5 Certified Pre-Owned (CPO) criteria.
 * Returns true if ALL 5 criteria are strictly true; false otherwise.
 *
 * @param {object} criteria
 * @param {boolean} criteria.noMajorAccident
 * @param {boolean} criteria.noWaterDamage
 * @param {boolean} criteria.engineGearboxIntact
 * @param {boolean} criteria.verifiedOdo
 * @param {boolean} criteria.electricalSystemPassed
 * @returns {boolean}
 */
export const evaluateCPO = (criteria = {}) => {
  if (!criteria || typeof criteria !== 'object') return false;

  const {
    noMajorAccident,
    noWaterDamage,
    engineGearboxIntact,
    verifiedOdo,
    electricalSystemPassed,
  } = criteria;

  return (
    noMajorAccident === true &&
    noWaterDamage === true &&
    engineGearboxIntact === true &&
    verifiedOdo === true &&
    electricalSystemPassed === true
  );
};

/**
 * Generates a CPO certificate identifier in format: CPO-YYYYMMDD-XXXX
 * where YYYYMMDD is the current date and XXXX is 4 random uppercase alphanumeric characters.
 *
 * @returns {string}
 */
export const generateCpoCertificate = () => {
  const dateStr = dayjs().format('YYYYMMDD');
  const randomSuffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `CPO-${dateStr}-${randomSuffix}`;
};

/**
 * Evaluates and records a car inspection.
 * - Car must exist and be in DRAFT or UNDER_INSPECTION status.
 * - If passed: car becomes APPROVED_CPO, receives a CPO certificate.
 * - If failed: car becomes REJECTED.
 *
 * @param {string} carId - Target vehicle ID
 * @param {string} inspectorId - ID of authenticated inspector
 * @param {object} payload - { criteria, odo, notes, evidenceImages }
 * @returns {Promise<{ car: object, inspectionRecord: object }>}
 */
export const inspectCar = async (carId, inspectorId, payload = {}) => {
  const car = await Car.findById(carId);
  if (!car) {
    throw new AppError('Car not found.', 404, 'CAR_NOT_FOUND');
  }

  const allowedStatuses = [CarStatus.UNDER_INSPECTION, CarStatus.DRAFT];
  if (!allowedStatuses.includes(car.status)) {
    throw new AppError(
      `Car is not in an inspectable status. Must be DRAFT or UNDER_INSPECTION. Current status: ${car.status}`,
      400,
      'INVALID_CAR_STATUS'
    );
  }

  const isPassed = evaluateCPO(payload.criteria);

  if (isPassed) {
    const cpoCertificateId = generateCpoCertificate();
    car.status = CarStatus.APPROVED_CPO;
    car.cpoCertificateId = cpoCertificateId;
  } else {
    car.status = CarStatus.REJECTED;
    car.cpoCertificateId = null;
  }

  if (payload.odo !== undefined && payload.odo !== null) {
    car.mileage = Number(payload.odo);
  }

  await car.save();

  const inspectionRecord = await InspectionRecord.create({
    carId: car._id,
    inspectorId,
    criteria: {
      noMajorAccident: Boolean(payload.criteria?.noMajorAccident),
      noWaterDamage: Boolean(payload.criteria?.noWaterDamage),
      engineGearboxIntact: Boolean(payload.criteria?.engineGearboxIntact),
      verifiedOdo: Boolean(payload.criteria?.verifiedOdo),
      electricalSystemPassed: Boolean(payload.criteria?.electricalSystemPassed),
    },
    odo: Number(payload.odo) || car.mileage || 0,
    notes: payload.notes || '',
    evidenceImages: Array.isArray(payload.evidenceImages) ? payload.evidenceImages : [],
    result: isPassed ? 'PASSED' : 'FAILED',
    cpoCertificateId: isPassed ? car.cpoCertificateId : null,
  });

  return {
    car,
    inspectionRecord,
  };
};

/**
 * Approves an inspected CPO car for sale.
 * - Car must exist and be in APPROVED_CPO status.
 * - Updates status to AVAILABLE.
 *
 * @param {string} carId - Target vehicle ID
 * @returns {Promise<object>} Updated car document
 */
export const approveSale = async (carId) => {
  const car = await Car.findById(carId);
  if (!car) {
    throw new AppError('Car not found.', 404, 'CAR_NOT_FOUND');
  }

  if (car.status !== CarStatus.APPROVED_CPO) {
    throw new AppError(
      `Only cars with status APPROVED_CPO can be approved for sale. Current status: ${car.status}`,
      400,
      'INVALID_STATUS_FOR_SALE'
    );
  }

  car.status = CarStatus.AVAILABLE;
  if (!car.listedDate) {
    car.listedDate = new Date();
  }
  await car.save();

  return car;
};

export default {
  evaluateCPO,
  generateCpoCertificate,
  inspectCar,
  approveSale,
};

