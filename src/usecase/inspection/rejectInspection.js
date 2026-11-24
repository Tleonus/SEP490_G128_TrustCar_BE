import { ActivityEventType, InspectionStatus } from '../../constants/appConstants.js';

const pendingApprovalStatus = 'PENDING_APPROVAL';

function rejectionError(code, message, errors) {
  return Object.assign(new Error(message), { code, ...(errors ? { errors } : {}) });
}

function notPending() {
  return rejectionError('INSPECTION_NOT_PENDING_APPROVAL', 'Only an inspection awaiting approval can be rejected.');
}

export function createRejectInspection({ unitOfWork, now = () => new Date() }) {
  /**
   * Return a pending inspection to its editable draft and record the rejection.
   * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-028
   * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-037
   */
  return async function rejectInspection(inspectionId, actorId, reason) {
    if (typeof inspectionId !== 'string' || !/^[a-f\d]{24}$/i.test(inspectionId)) {
      throw rejectionError('VALIDATION_ERROR', 'Invalid inspection ID.', [{ field: 'id', message: 'Expected an ObjectId.' }]);
    }
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    if (trimmed.length < 10 || trimmed.length > 1000) {
      throw rejectionError('VALIDATION_ERROR', 'Invalid rejection reason.', [
        { field: 'reason', message: 'Reason must be between 10 and 1000 characters.' },
      ]);
    }

    return unitOfWork.run(async ({ records, audit }) => {
      const record = await records.findById(inspectionId);
      if (!record) throw rejectionError('INSPECTION_NOT_FOUND', 'Inspection not found.');
      if (record.status !== pendingApprovalStatus) throw notPending();

      const updated = await records.updateIfCurrent(inspectionId, { status: pendingApprovalStatus }, {
        status: InspectionStatus.DRAFT, templateSnapshot: null,
        rejectedReason: trimmed, rejectedByUserId: actorId, rejectedAt: now(), updatedBy: actorId,
      });
      if (!updated) throw notPending();
      await audit.append({
        eventType: ActivityEventType.INSPECTION_REJECTED, performedBy: actorId,
        targetModel: 'InspectionRecord', targetId: inspectionId, summary: 'Inspection rejected and returned to draft',
        metadata: {
          carId: record.carId, reason: trimmed, fromStatus: pendingApprovalStatus, toStatus: InspectionStatus.DRAFT,
        },
      });
      return updated;
    });
  };
}
