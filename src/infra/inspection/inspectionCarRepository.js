import mongoose from 'mongoose';
import { CarStatus, FuelType } from '../../constants/appConstants.js';
import Car from '../../models/Car.js';

const carFields = 'vehicleCode status fuelType updatedAt make model variant year mileage specifications.color cpoCertificateId historyVerifyHash isActive';
const carStatuses = Object.values(CarStatus);
const fuelTypes = Object.values(FuelType);
const mutableFields = ['status', 'mileage', 'cpoCertificateId', 'historyVerifyHash'];

function toCar(document) {
  if (!document) return null;
  const { _id, specifications, fuelType, updatedAt, ...fields } = document;
  return {
    ...fields,
    id: String(_id),
    fuelType: fuelType ?? null,
    updatedAt: updatedAt ?? null,
    color: specifications?.color ?? null,
  };
}

/**
 * Serialize competing inspection operations on the same vehicle document.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-001
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-020
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-035
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-039
 */
export function createInspectionCarRepository({ session, model = Car } = {}) {
  async function updateIfCurrent(id, expected, changes) {
    if (!session?.inTransaction()) throw new Error('Inspection car writes require an active transaction.');
    const { status, fuelType, updatedAt, cpoCertificateId } = expected ?? {};
    const previousTime = updatedAt === null ? 0 : updatedAt instanceof Date ? updatedAt.getTime() : NaN;
    if (!mongoose.isObjectIdOrHexString(id) || !carStatuses.includes(status) ||
        (fuelType !== null && !fuelTypes.includes(fuelType)) || !Number.isFinite(previousTime)) {
      throw new TypeError('Inspection car update requires an ID, status, fuel type and update timestamp.');
    }

    const fields = Object.fromEntries(mutableFields
      .filter((field) => Object.hasOwn(changes, field))
      .map((field) => [field, changes[field]]));
    // Always make a real write, including two requests in the same millisecond.
    fields.updatedAt = new Date(Math.max(Date.now(), previousTime + 1));
    return toCar(await model.findOneAndUpdate(
      { _id: id, status, fuelType, updatedAt, ...(typeof cpoCertificateId === 'string' ? { cpoCertificateId } : {}) },
      { $set: fields },
      { session, new: true, runValidators: true, timestamps: false, projection: carFields },
    ).lean());
  }

  return {
    async findById(id) {
      if (!mongoose.isObjectIdOrHexString(id)) return null;
      return toCar(await model.findById(id, carFields, { session }).lean());
    },
    claimForInspection(id, expected) {
      return updateIfCurrent(id, expected, {});
    },
    updateIfCurrent,
  };
}
