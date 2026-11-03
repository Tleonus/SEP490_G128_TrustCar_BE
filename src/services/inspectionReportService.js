/**
 * @file inspectionReportService.js
 * @description Public CPO inspection report of a car (no authentication).
 *
 * A report exists only for an active car that is APPROVED_CPO or AVAILABLE,
 * carries a CPO certificate, and whose certifying inspection record (same
 * cpoCertificateId) is SUBMITTED and PASSED. Every other case answers the same
 * 404, so callers cannot tell "unknown car" from "no report".
 *
 * Reads at most 3 documents: the car, the certifying record, the inspector's name.
 */

import Car from '../models/Car.js';
import InspectionRecord from '../models/InspectionRecord.js';
import User from '../models/User.js';
import { CarStatus, InspectionStatus } from '../constants/appConstants.js';
import { AppError } from '../utils/apiResponse.js';
import { buildPublicReport } from './inspectionReportMapper.js';

const REPORTABLE_CAR_STATUSES = [CarStatus.APPROVED_CPO, CarStatus.AVAILABLE];
const CAR_PROJECTION = {
  status: 1, isActive: 1, cpoCertificateId: 1, make: 1, model: 1, variant: 1, year: 1, 'specifications.color': 1,
};

const reportNotFound = () =>
  new AppError('Inspection report not found.', 404, 'INSPECTION_REPORT_NOT_FOUND');

/**
 * @param {string} idOrCode - car ObjectId or vehicleCode (TC-YYYY-NNNN)
 * @returns {Promise<object>} public report (SPEC KAN-15 §5)
 */
export const getPublicInspectionReport = async (idOrCode) => {
  const key = String(idOrCode);
  const byId = /^[0-9a-fA-F]{24}$/.test(key);
  const car = await Car.findOne({
    ...(byId ? { _id: key } : { vehicleCode: key }),
    isActive: true,
    status: { $in: REPORTABLE_CAR_STATUSES },
    cpoCertificateId: { $ne: null },
  }, CAR_PROJECTION).lean();
  if (!car?.cpoCertificateId) throw reportNotFound();

  const record = await InspectionRecord.findOne({
    carId: car._id,
    cpoCertificateId: car.cpoCertificateId,
  }).lean();
  // Records without a status predate the digital checklist and were always final.
  const submitted = record && (record.status || InspectionStatus.SUBMITTED) === InspectionStatus.SUBMITTED;
  if (!submitted || record.result !== 'PASSED') throw reportNotFound();

  const inspectorId = record.submittedBy || record.inspectorId;
  const inspector = inspectorId ? await User.findById(inspectorId).select('fullName').lean() : null;

  return buildPublicReport({ car, record, inspectorName: inspector?.fullName ?? null });
};

export default { getPublicInspectionReport };
