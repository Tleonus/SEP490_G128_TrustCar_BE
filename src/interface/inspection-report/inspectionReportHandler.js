import { PUBLIC_REPORT_SCOPE_NOTE } from '../../config/inspectionChecklist.js';
import { AppError, sendSuccess } from '../../utils/apiResponse.js';

/** @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-009
 * @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-010
 * @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-011
 */
function publicReport({ certificateId, issuedAt, level, inspector, vehicle, groups }) {
  const { make, model, variant, color, year, mileage } = vehicle;
  return {
    certificateId,
    issuedAt,
    level,
    inspector,
    vehicle: { make, model, variant, color, year, mileage },
    overviewPhotos: null,
    groups: groups.map(({ key, label, passed }) => ({
      key, label, passed, items: [], photos: [], minorDefects: [],
    })),
    photos: [],
    scopeNote: PUBLIC_REPORT_SCOPE_NOTE,
  };
}

/** @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-001
 * @ears .sdd/features/kan-15-cpo-certificate-json-api/SPEC.md#REQ-003
 */
export function createInspectionReportHandler({ getInspectionReport }) {
  return async function inspectionReportHandler(req, res, next) {
    try {
      const report = await getInspectionReport(req.params.id);
      return sendSuccess(res, 200, 'Inspection report retrieved successfully.', publicReport(report));
    } catch (error) {
      if (error?.code === 'INSPECTION_REPORT_NOT_FOUND') {
        return next(new AppError('Inspection report not found.', 404, 'INSPECTION_REPORT_NOT_FOUND'));
      }
      return next(error);
    }
  };
}
