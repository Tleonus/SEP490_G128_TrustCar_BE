import { ActivityEventType, CarStatus, InspectionStatus, Permissions, Roles } from '../../constants/appConstants.js';
import { CPO_CRITERIA, evaluateCpo } from '../../domain/inspection/criteria.js';
import { collectDefinitionIssues, deriveDetailedCriteria, QuestionType } from '../../domain/inspection/formDefinition.js';
import { assessCriterionResults, isCertifiedForReinspection, isCriteriaTemplate } from './criteriaInspection.js';

const PENDING_APPROVAL = 'PENDING_APPROVAL';
const MAX_CERTIFICATE_ATTEMPTS = 3;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const criteriaByGroup = new Map(CPO_CRITERIA.map((criterion) => [criterion.key, criterion]));

function approvalError(code, message, errors) {
  return Object.assign(new Error(message), { code, ...(errors ? { errors } : {}) });
}

function notPending() {
  return approvalError('INSPECTION_NOT_PENDING_APPROVAL', 'Only an inspection awaiting approval can be approved.');
}

function invalidCarStatus() {
  return approvalError('INVALID_CAR_STATUS', 'Car is no longer under inspection.');
}

/** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-034 */
function requireAdmin(actor) {
  if (typeof actor?.id !== 'string' || !OBJECT_ID.test(actor.id) ||
      !Array.isArray(actor.roleNames) || !actor.roleNames.includes(Roles.ADMIN) ||
      !Array.isArray(actor.permissions) || !actor.permissions.includes(Permissions.INSPECTION_ADMIN)) {
    throw approvalError('FORBIDDEN', 'Approval requires the ADMIN role and inspection administration permission.');
  }
}

/** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-033 */
function collectEvidence(template, answers, recordImages) {
  const imageQuestionIds = new Set(template.groups.flatMap(({ questions }) => questions
    .filter(({ type }) => type === QuestionType.IMAGE)
    .map(({ id }) => id)));
  const formImages = answers.flatMap(({ questionId, value }) =>
    imageQuestionIds.has(questionId) && Array.isArray(value) ? value : []);
  return [...new Set([...recordImages.map(({ url }) => url), ...formImages])];
}

/**
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-026
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-033
 */
export function buildVerdict(record, listRecordImages) {
  const { templateSnapshot, answers, submittedBy } = record;
  const odo = record.vehicleInfo?.confirmed?.mileage;
  if (!OBJECT_ID.test(submittedBy) || !Array.isArray(answers) ||
      !Number.isSafeInteger(odo) || odo < 0 || collectDefinitionIssues(templateSnapshot).length) {
    throw new Error('The pending inspection is missing valid submission data.');
  }

  const criteria = deriveDetailedCriteria(templateSnapshot, answers);
  const passed = evaluateCpo(criteria);
  const groups = (record.groups ?? []).map((group) => ({
    ...group, passed: criteria[criteriaByGroup.get(group.groupKey)?.criteriaKey] === true,
  }));
  const notes = groups.filter(({ note }) => note?.trim()).map(({ groupKey, note }) =>
    `${criteriaByGroup.get(groupKey)?.label ?? groupKey}: ${note.trim()}`).join('\n');

  return {
    passed,
    recordChanges: {
      criteria, groups, odo, notes, result: passed ? 'PASSED' : 'FAILED',
      evidenceImages: collectEvidence(templateSnapshot, answers, listRecordImages(record)),
    },
  };
}

export function buildCriteriaVerdict(record, template, results) {
  const { missing, passed } = assessCriterionResults(template, results);
  if (missing.length || !Number.isSafeInteger(record.odo) || record.odo < 0) {
    throw approvalError('INSPECTION_INCOMPLETE', 'The inspection is incomplete.');
  }
  return { passed, recordChanges: { odo: record.odo, result: passed ? 'PASSED' : 'FAILED' } };
}

/** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-028 */
async function appendFinalizationEvents(audit, record, beforeCar, afterCar, actorId, fromStatus) {
  const { id: inspectionId, result, cpoCertificateId } = record;
  const metadata = { inspectionId, carId: afterCar.id, result, cpoCertificateId };
  // The existing event type records the transition into SUBMITTED.
  await audit.append({
    eventType: ActivityEventType.INSPECTION_SUBMITTED,
    performedBy: actorId, targetModel: 'InspectionRecord', targetId: inspectionId,
    summary: `Inspection finalized: ${result}`,
    metadata: { ...metadata, templateRevision: record.templateRevision, action: fromStatus === PENDING_APPROVAL ? 'APPROVE' : 'SUBMIT',
      fromStatus, toStatus: InspectionStatus.SUBMITTED },
  });
  if (beforeCar.status !== afterCar.status) {
    await audit.append({
      eventType: ActivityEventType.CAR_STATUS_CHANGED,
      performedBy: actorId, targetModel: 'Car', targetId: afterCar.id, targetCode: afterCar.vehicleCode ?? null,
      changes: { before: { status: beforeCar.status }, after: { status: afterCar.status } },
      summary: `Inspection ${result}`, metadata,
    });
  } else if (cpoCertificateId && beforeCar.cpoCertificateId !== cpoCertificateId) {
    await audit.append({
      eventType: ActivityEventType.CAR_UPDATED,
      performedBy: actorId, targetModel: 'Car', targetId: afterCar.id, targetCode: afterCar.vehicleCode ?? null,
      changes: {
        before: { cpoCertificateId: beforeCar.cpoCertificateId },
        after: { cpoCertificateId },
      },
      summary: 'CPO certificate renewed', metadata,
    });
  }
}

/** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-052 */
export async function commitInspectionVerdict({ records, cars, audit }, {
  inspectionId, actorId, car, expected, submission, verdict, reinspection, getCertificateId,
  buildHistoryVerifyHash, now, publishOnPass = false,
}) {
  const { passed, recordChanges } = verdict;
  const cpoCertificateId = passed ? getCertificateId() : null;
  if (reinspection && cpoCertificateId === car.cpoCertificateId) {
    throw approvalError('CPO_CERTIFICATE_ALREADY_IN_USE', 'Generate a different certificate for reinspection.');
  }
  const inspectionRecord = await records.updateIfCurrent(inspectionId, expected, {
    ...submission, ...recordChanges, cpoCertificateId, status: InspectionStatus.SUBMITTED, updatedBy: actorId,
  });
  if (!inspectionRecord) {
    if (expected.status === PENDING_APPROVAL) throw notPending();
    throw approvalError('INSPECTION_LOCKED', 'This inspection is locked.');
  }

  let carChanges = {};
  if (passed || !reinspection) {
    const status = passed
      ? (publishOnPass ? CarStatus.AVAILABLE : reinspection ? car.status : CarStatus.APPROVED_CPO)
      : CarStatus.REJECTED;
    carChanges = {
      status, mileage: Math.max(car.mileage ?? 0, recordChanges.odo), cpoCertificateId,
      historyVerifyHash: passed ? buildHistoryVerifyHash(car.id, cpoCertificateId) : null,
      ...(publishOnPass && passed && car.listedDate == null ? { listedDate: now() } : {}),
    };
  }
  const updatedCar = await cars.updateIfCurrent(car.id, car, carChanges);
  if (!updatedCar) throw invalidCarStatus();
  await appendFinalizationEvents(audit, inspectionRecord, car, updatedCar, actorId, expected.status);
  return { car: updatedCar, inspectionRecord };
}

export async function withInspectionCertificate({ unitOfWork, generateCpoCertificate, isCertificateCollision }, action) {
  for (let attempt = 0; attempt < MAX_CERTIFICATE_ATTEMPTS; attempt += 1) {
    let candidate;
    try {
      return await unitOfWork.run(repositories => action(repositories, () => (candidate ??= generateCpoCertificate())));
    } catch (error) {
      if (!candidate || (error.code !== 'CPO_CERTIFICATE_ALREADY_IN_USE' && !isCertificateCollision(error))) throw error;
    }
  }
  throw approvalError('CPO_CODE_GENERATION_FAILED', 'Could not generate a unique CPO certificate code.');
}

/**
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-033
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-034
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-035
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-036
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-038
 */
async function finalizeInspection({ records, cars, templates, results, audit }, {
  inspectionId, actorId, getCertificateId, buildHistoryVerifyHash, listRecordImages, now,
}) {
  const record = await records.findById(inspectionId);
  if (!record) throw approvalError('INSPECTION_NOT_FOUND', 'Inspection not found.');
  if (record.status !== PENDING_APPROVAL) throw notPending();
  if (String(record.submittedBy).toLowerCase() === actorId.toLowerCase()) {
    throw approvalError('INSPECTION_SELF_APPROVAL', 'The person who submitted the inspection cannot approve it.');
  }

  const car = await cars.findById(record.carId);
  if (!car) throw approvalError('CAR_NOT_FOUND', 'Car not found.');
  const template = record.templateSnapshot == null && Number.isSafeInteger(record.templateRevision)
    ? await templates.findRevision(record.templateKey, record.templateRevision)
    : null;
  const compact = isCriteriaTemplate(template);
  const reinspection = compact && isCertifiedForReinspection(car);
  if (car.status !== CarStatus.UNDER_INSPECTION && !reinspection) throw invalidCarStatus();

  const scores = compact ? await results.findByInspectionId(record.id) : null;
  const verdict = compact ? buildCriteriaVerdict(record, template, scores) : buildVerdict(record, listRecordImages);
  const published = await commitInspectionVerdict({ records, cars, audit }, {
    inspectionId, actorId, car, expected: { status: PENDING_APPROVAL }, verdict, reinspection,
    submission: { approvedBy: actorId, approvedAt: now() }, getCertificateId, buildHistoryVerifyHash, now,
  });
  return compact ? { ...published, inspectionRecord: { ...published.inspectionRecord, template, results: scores } } : published;
}

/**
 * The composition root supplies the existing certificate, history and media helpers.
 * isCertificateCollision recognizes only a duplicate key for cpoCertificateId.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-016
 */
export function createApproveInspection({
  unitOfWork, generateCpoCertificate, buildHistoryVerifyHash, listRecordImages, isCertificateCollision,
  now = () => new Date(),
}) {
  return async function approveInspection(inspectionId, actor) {
    requireAdmin(actor);
    if (typeof inspectionId !== 'string' || !OBJECT_ID.test(inspectionId)) {
      throw approvalError('VALIDATION_ERROR', 'Invalid inspection ID.', [{ field: 'id', message: 'Expected an ObjectId.' }]);
    }

    return withInspectionCertificate({ unitOfWork, generateCpoCertificate, isCertificateCollision },
      (repositories, getCertificateId) => finalizeInspection(repositories, {
        inspectionId, actorId: actor.id, now, buildHistoryVerifyHash, listRecordImages, getCertificateId,
      }));
  };
}
