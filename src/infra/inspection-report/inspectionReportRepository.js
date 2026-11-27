import mongoose from 'mongoose';
import { CarStatus, InspectionStatus } from '../../constants/appConstants.js';
import { CPO_CRITERIA } from '../../domain/inspection/criteria.js';
import Car from '../../models/Car.js';
import InspectionRecord from '../../models/InspectionRecord.js';
import User from '../../models/User.js';
import { readCertificateCriteria } from './certificateCriteriaReader.js';

const reportableStatuses = [CarStatus.APPROVED_CPO, CarStatus.AVAILABLE];
const criteriaFields = CPO_CRITERIA.map(({ criteriaKey }) => criteriaKey);
const confirmedFields = ['make', 'model', 'variant', 'color', 'year', 'mileage'];
const carProjection = {
  _id: 1, isActive: 1, status: 1, cpoCertificateId: 1,
  make: 1, model: 1, variant: 1, year: 1, 'specifications.color': 1,
};
const recordProjection = {
  _id: 1, carId: 1, cpoCertificateId: 1, status: 1, source: 1, result: 1,
  odo: 1, submittedAt: 1, createdAt: 1, submittedBy: 1, inspectorId: 1,
  templateKey: 1, checklistVersion: 1, 'checklistSnapshot.revision': 1,
  ...Object.fromEntries(criteriaFields.map((field) => [`criteria.${field}`, 1])),
  ...Object.fromEntries(confirmedFields.map((field) => [`vehicleInfo.confirmed.${field}`, 1])),
};

const isIdString = (value) => typeof value === 'string' && mongoose.isObjectIdOrHexString(value);
const idAsString = (value) => mongoose.isObjectIdOrHexString(value) ? String(value).toLowerCase() : null;

function pickFields(document, fields) {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(document, field))
    .map((field) => [field, document[field]]));
}

function lookupFilter(lookup) {
  if (lookup?.kind === 'id' && isIdString(lookup.value)) return { _id: lookup.value };
  if (lookup?.kind === 'vehicleCode' && typeof lookup.value === 'string' &&
      lookup.value.length === 12 && /^TC-\d{4}-\d{4}$/.test(lookup.value)) {
    return { vehicleCode: lookup.value };
  }
  return null;
}

/** @returns {import('../../usecase/inspection-report/ports/inspectionReportPort.js').InspectionReportReader} */
export function createInspectionReportRepository({
  carModel = Car, recordModel = InspectionRecord, userModel = User, readCriteria = readCertificateCriteria,
} = {}) {
  return {
    /** @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-002 */
    async findCar(lookup) {
      const filter = lookupFilter(lookup);
      if (!filter) return null;
      const car = await carModel.findOne({
        ...filter,
        isActive: true,
        status: { $in: reportableStatuses },
        cpoCertificateId: { $ne: null },
      }, carProjection).lean();
      if (!car) return null;

      return {
        id: idAsString(car._id),
        isActive: car.isActive,
        status: car.status,
        cpoCertificateId: car.cpoCertificateId,
        make: car.make,
        model: car.model,
        variant: car.variant,
        year: car.year,
        color: car.specifications?.color ?? null,
      };
    },

    /** @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-003 */
    async findCertifyingInspection(carId, certificateId) {
      if (!isIdString(carId) || typeof certificateId !== 'string' || !certificateId.trim()) return null;
      const record = await recordModel.findOne({
        carId,
        cpoCertificateId: certificateId,
        result: 'PASSED',
        // Equality with null also matches legacy documents without a status.
        $or: [{ status: InspectionStatus.SUBMITTED }, { status: null }],
      }, recordProjection).sort({ createdAt: -1, _id: -1 }).lean();
      if (!record) return null;

      const confirmed = record.vehicleInfo?.confirmed;
      const certificateCriteria = await readCriteria(record, { includeInspector: true });
      return {
        carId: idAsString(record.carId),
        cpoCertificateId: record.cpoCertificateId,
        status: record.status,
        source: record.source,
        result: record.result,
        criteria: pickFields(record.criteria ?? {}, criteriaFields),
        confirmedVehicle: confirmed ? pickFields(confirmed, confirmedFields) : null,
        odo: record.odo,
        submittedAt: record.submittedAt,
        createdAt: record.createdAt,
        submittedBy: idAsString(record.submittedBy),
        inspectorId: idAsString(record.inspectorId),
        ...certificateCriteria,
      };
    },

    /** @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-008 */
    async findInspectorName(inspectorId) {
      if (!isIdString(inspectorId)) return null;
      const user = await userModel.findById(inspectorId, { _id: 0, fullName: 1 }).lean();
      return typeof user?.fullName === 'string' ? user.fullName : null;
    },
  };
}
