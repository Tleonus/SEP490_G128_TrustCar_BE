import { randomUUID } from 'node:crypto';
import { InspectionSource, InspectionStatus } from '../../constants/appConstants.js';
import { SystemMessages as messages } from '../../constants/systemMessages.js';
import { sendSuccess } from '../../utils/apiResponse.js';

const errorsByCode = new Map([
  ...[messages.MSG01, messages.MSG02, messages.MSG03, messages.MSG04, messages.MSG05, messages.MSG06,
    messages.MSG_ACCOUNT_LOCKED, messages.MSG74, messages.MSG42, messages.MSG62]
    .map(({ code, httpStatus, message }) => [code, [httpStatus, message]]),
  ['INSPECTION_INCOMPLETE', [400, 'The inspection is incomplete.']],
  ['MILEAGE_DECREASE', [400, 'Odometer reading cannot be lower than the recorded mileage.']],
  ['INVALID_CAR_STATUS', [400, 'Car cannot be inspected in its current status.']],
  ['INVALID_STATUS_FOR_SALE', [400, 'Only cars with status APPROVED_CPO can be approved for sale.']],
  ['INSPECTION_SELF_APPROVAL', [403, 'The person who submitted the inspection cannot approve it.']],
  ['CAR_NOT_FOUND', [404, 'Car not found.']],
  ['INSPECTION_NOT_FOUND', [404, 'Inspection not found.']],
  ['INSPECTION_DRAFT_EXISTS', [409, 'The car already has a draft inspection.']],
  ['INSPECTION_PENDING_APPROVAL', [409, 'The car already has an inspection awaiting approval.']],
  ['INSPECTION_LOCKED', [409, 'This inspection is locked.']],
  ['INSPECTION_NOT_PENDING_APPROVAL', [409, 'The inspection is not awaiting approval.']],
  ['FORM_REVISION_CONFLICT', [409, 'The template revision has changed.']],
  ['INSPECTION_TEMPLATE_NOT_AVAILABLE', [409, 'No inspection template is available.']],
  ['INSPECTION_FORM_TYPE_MISMATCH', [409, 'The car does not match the saved inspection template.']],
  ['CPO_CODE_GENERATION_FAILED', [500, 'Could not generate a unique CPO certificate code.']],
  ['UPLOAD_NOT_CONFIGURED', [503, 'Image upload is not configured.']],
]);
const safeField = /^[a-z0-9_.-]{1,120}$/i;
const objectId = /^[a-f0-9]{24}$/i;
const openCodes = new Set(['INSPECTION_DRAFT_EXISTS', 'INSPECTION_PENDING_APPROVAL']);
const detailCodes = new Set(['VALIDATION_ERROR', 'INSPECTION_INCOMPLETE', ...openCodes]);

function safeDetails(code, errors) {
  if (!detailCodes.has(code) || !Array.isArray(errors)) return undefined;
  return errors.filter((item) => item && typeof item === 'object').map((item) => {
    const field = typeof item.field === 'string' && safeField.test(item.field) ? item.field : 'unknown';
    if (openCodes.has(code)) {
      return field === 'inspectionId' && typeof item.message === 'string' && objectId.test(item.message)
        ? { field, message: item.message }
        : { field, message: 'The car has an open inspection.' };
    }
    const detail = {
      field,
      message: typeof item.message === 'string' ? item.message.slice(0, 240) : 'Invalid field.',
    };
    for (const key of ['code', 'questionId', 'optionId']) {
      if (typeof item[key] === 'string' && safeField.test(item[key])) detail[key] = item[key];
    }
    return detail;
  });
}

export function sendInspectionError(res, error, { conflictingCarStatus = false } = {}) {
  const code = errorsByCode.has(error?.code) ? error.code : messages.MSG62.code;
  const [defaultStatus, message] = errorsByCode.get(code);
  const status = code === 'INVALID_CAR_STATUS' && conflictingCarStatus ? 409 : defaultStatus;
  const details = safeDetails(code, error?.errors);
  return res.status(status).json({
    success: false, message, code, ...(details ? { errors: details } : {}),
    error_code: code, request_id: randomUUID(), timestamp: new Date().toISOString(),
  });
}

const recordFields = [
  'carId', 'inspectorId', 'criteria', 'odo', 'notes', 'evidenceImages', 'result', 'cpoCertificateId', 'status',
  'source', 'templateKey', 'checklistVersion', 'templateRevision', 'template', 'answers', 'archivedAnswers',
  'createdBy', 'updatedBy', 'submittedBy', 'submittedAt', 'approvedBy', 'approvedAt',
  'rejectedReason', 'rejectedByUserId', 'rejectedAt', 'vehicleInfo', 'overviewPhotos', 'groups', 'createdAt', 'updatedAt',
];
const carFields = [
  'vehicleCode', 'make', 'model', 'variant', 'year', 'fuelType', 'mileage', 'status', 'color', 'createdAt', 'updatedAt',
  'isActive', 'cpoCertificateId', 'historyVerifyHash', 'listedDate',
];
const pick = (record, fields) => Object.fromEntries(
  fields.filter((field) => record[field] !== undefined).map((field) => [field, record[field]]),
);

/** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-018 */
export function inspectionResponse(record) {
  const data = pick(record, recordFields);
  return {
    _id: record.id ?? record._id,
    ...data,
    status: data.status ?? InspectionStatus.SUBMITTED,
    source: data.source ?? InspectionSource.LEGACY,
    ...(record.templateSnapshot != null ? { checklistSnapshot: record.templateSnapshot } : {}),
  };
}

export function carResponse(car) {
  return { _id: car.id ?? car._id, ...pick(car, carFields) };
}

export function verdictResponse({ car, inspectionRecord }) {
  return { car: carResponse(car), inspectionRecord: inspectionResponse(inspectionRecord) };
}

export function result(status, message, project = (value) => value) {
  return (res, data) => sendSuccess(res, status, message, project(data));
}
