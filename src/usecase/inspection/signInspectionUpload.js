import { CarStatus, InspectionStatus, Permissions } from '../../constants/appConstants.js';

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const SIGNABLE_CAR_STATUSES = new Set([
  CarStatus.DRAFT, CarStatus.INCOMING, CarStatus.REJECTED, CarStatus.UNDER_INSPECTION,
]);

function signatureError(code, message, errors) {
  return Object.assign(new Error(message), { code, ...(errors ? { errors } : {}) });
}

/** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-032 */
function authorize(actor, id) {
  if (typeof actor?.id !== 'string' || !OBJECT_ID.test(actor.id) ||
      !Array.isArray(actor.permissions) || !actor.permissions.includes(Permissions.INSPECTION_WRITE)) {
    throw signatureError('FORBIDDEN', 'Signing an inspection upload requires inspection write permission.');
  }
  if (typeof id !== 'string' || !OBJECT_ID.test(id)) {
    throw signatureError('VALIDATION_ERROR', 'Invalid identifier.', [{ field: 'id', message: 'Expected an ObjectId.' }]);
  }
}

export function createInspectionUploadSigning({ records, cars, media }) {
  return {
    /**
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-010
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-011
     */
    async signInspectionUpload(inspectionId, actor) {
      authorize(actor, inspectionId);
      const record = await records.findById(inspectionId);
      if (!record) throw signatureError('INSPECTION_NOT_FOUND', 'Inspection not found.');
      if (record.status !== InspectionStatus.DRAFT) {
        throw signatureError('INSPECTION_LOCKED', 'This inspection is locked.');
      }
      return media.signInspectionPhoto(record.id);
    },

    /**
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-031
     * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-032
     */
    async signQuickInspectionUpload(carId, actor) {
      authorize(actor, carId);
      const car = await cars.findById(carId);
      if (!car) throw signatureError('CAR_NOT_FOUND', 'Car not found.');
      if (!SIGNABLE_CAR_STATUSES.has(car.status)) {
        throw signatureError('INVALID_CAR_STATUS', 'Car cannot be inspected in its current status.');
      }
      return media.signQuickInspectionPhoto(car.id);
    },
  };
}
