import { createGetInspectionReport } from '../../usecase/inspection-report/getInspectionReport.js';
import { createInspectionReportRepository } from './inspectionReportRepository.js';

export function wireInspectionReport() {
  return createGetInspectionReport({ reader: createInspectionReportRepository() });
}
