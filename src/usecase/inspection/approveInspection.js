import { ActivityEventType, CarStatus, InspectionStatus, Permissions, Roles } from '../../constants/appConstants.js';
import { CPO_CRITERIA, evaluateCpo } from '../../domain/inspection/criteria.js';
import { collectDefinitionIssues, deriveDetailedCriteria, QuestionType } from '../../domain/inspection/formDefinition.js';

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
function buildVerdict(record, listRecordImages) {
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

/** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-028 */
async function appendApprovalEvents(audit, record, beforeCar, afterCar, actorId) {
  const { id: inspectionId, result, cpoCertificateId } = record;
  const metadata = { inspectionId, carId: afterCar.id, result, cpoCertificateId };
  // The existing event type records the transition into SUBMITTED.
  await audit.append({
    eventType: ActivityEventType.INSPECTION_SUBMITTED,
    performedBy: actorId, targetModel: 'InspectionRecord', targetId: inspectionId,
    summary: `Inspection approved: ${result}`,
    metadata: { ...metadata, action: 'APPROVE', fromStatus: PENDING_APPROVAL, toStatus: InspectionStatus.SUBMITTED },
  });
  await audit.append({
    eventType: ActivityEventType.CAR_STATUS_CHANGED,
    performedBy: actorId, targetModel: 'Car', targetId: afterCar.id, targetCode: afterCar.vehicleCode ?? null,
    changes: { before: { status: beforeCar.status }, after: { status: afterCar.status } },
    summary: `Inspection ${result}`,
    metadata,
  });
}

/**
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-033
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-034
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-035
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-036
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-038
 */
async function finalizeInspection({ records, cars, audit }, {
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
  if (car.status !== CarStatus.UNDER_INSPECTION) throw invalidCarStatus();

  const { passed, recordChanges } = buildVerdict(record, listRecordImages);
  const cpoCertificateId = passed ? getCertificateId() : null;
  const inspectionRecord = await records.updateIfCurrent(record.id, { status: PENDING_APPROVAL }, {
    ...recordChanges, cpoCertificateId, status: InspectionStatus.SUBMITTED,
    approvedBy: actorId, approvedAt: now(), updatedBy: actorId,
  });
  if (!inspectionRecord) throw notPending();

  const updatedCar = await cars.updateIfCurrent(car.id, car, {
    status: passed ? CarStatus.APPROVED_CPO : CarStatus.REJECTED,
    mileage: Math.max(car.mileage ?? 0, recordChanges.odo),
    cpoCertificateId,
    historyVerifyHash: passed ? buildHistoryVerifyHash(car.id, cpoCertificateId) : null,
  });
  if (!updatedCar) throw invalidCarStatus();

  await appendApprovalEvents(audit, inspectionRecord, car, updatedCar, actorId);
  return { car: updatedCar, inspectionRecord };
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

    for (let attempt = 0; attempt < MAX_CERTIFICATE_ATTEMPTS; attempt += 1) {
      let candidate;
      try {
        return await unitOfWork.run((repositories) => finalizeInspection(repositories, {
          inspectionId, actorId: actor.id, now, buildHistoryVerifyHash, listRecordImages,
          getCertificateId: () => (candidate ??= generateCpoCertificate()),
        }));
      } catch (error) {
        // A duplicate write aborts the MongoDB transaction. Start a fresh one.
        if (!candidate || !isCertificateCollision(error)) throw error;
      }
    }

    throw approvalError('CPO_CODE_GENERATION_FAILED', 'Could not generate a unique CPO certificate code.');
  };
}
