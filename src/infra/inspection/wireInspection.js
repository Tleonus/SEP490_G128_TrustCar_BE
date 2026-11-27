import { generateCpoCertificate } from '../../services/inspectionVerdict.js';
import { listRecordImages } from '../../services/inspectionSubmitRules.js';
import { isDuplicateKey } from '../../services/inspectionShared.js';
import { approveSale } from '../../services/inspectionService.js';
import { buildHistoryVerifyHash } from '../../services/vehicleHistoryService.js';
import { createApproveInspection } from '../../usecase/inspection/approveInspection.js';
import { createInspectionDraftUseCases } from '../../usecase/inspection/manageDrafts.js';
import { createFormTemplateUseCases } from '../../usecase/inspection/manageTemplates.js';
import { createTemplateProposalUseCases } from '../../usecase/inspection/manageTemplateProposals.js';
import { createQuickInspection } from '../../usecase/inspection/quickInspection.js';
import { createRejectInspection } from '../../usecase/inspection/rejectInspection.js';
import { createInspectionUploadSigning } from '../../usecase/inspection/signInspectionUpload.js';
import { createSubmitInspection } from '../../usecase/inspection/submitInspection.js';
import { createFormTemplateRepository } from './formTemplateRepository.js';
import { createInspectionCarRepository } from './inspectionCarRepository.js';
import { createInspectionMediaAdapter } from './inspectionMediaAdapter.js';
import { createInspectionRecordRepository } from './inspectionRecordRepository.js';
import { createInspectionResultRepository } from './inspectionResultRepository.js';
import { createInspectionUnitOfWork } from './inspectionUnitOfWork.js';
import { createInspectionListingRepository } from './inspectionListingRepository.js';

/** Compose the ports for the inspection module. The application's router owns mounting. */
export function wireInspection({
  makeTemplates = createFormTemplateRepository,
  makeRecords = createInspectionRecordRepository,
  makeCars = createInspectionCarRepository,
  listings = createInspectionListingRepository(),
  bindAudit,
  runTransaction,
  media = createInspectionMediaAdapter(),
} = {}) {
  const templates = makeTemplates();
  const records = makeRecords();
  const results = createInspectionResultRepository();
  const cars = makeCars();
  const unitOfWork = createInspectionUnitOfWork({
    bindTemplates: (session) => makeTemplates({ session }),
    bindRecords: (session) => makeRecords({ session }),
    bindCars: (session) => makeCars({ session }),
    bindAudit,
    runTransaction,
  });
  const isInspectionImageUrl = media.isInspectionImageUrl;
  const verdictDependencies = {
    unitOfWork, generateCpoCertificate, buildHistoryVerifyHash,
    isCertificateCollision: (error) => isDuplicateKey(error, 'cpoCertificateId'),
  };

  return {
    ...createFormTemplateUseCases({ templates, unitOfWork }),
    ...createTemplateProposalUseCases({ templates, unitOfWork }),
    ...createInspectionDraftUseCases({ templates, records, results, cars, listings, unitOfWork, isInspectionImageUrl }),
    ...createInspectionUploadSigning({ records, cars, media }),
    submitInspection: createSubmitInspection({ ...verdictDependencies, isInspectionImageUrl, listRecordImages }),
    rejectInspection: createRejectInspection({ unitOfWork }),
    approveInspection: createApproveInspection({ ...verdictDependencies, listRecordImages }),
    inspectCar: createQuickInspection({
      ...verdictDependencies, isQuickInspectionImageUrl: media.isQuickInspectionImageUrl,
    }),
    approveSale,
  };
}
