import ActivityLog from '../../models/ActivityLog.js';

/**
 * Append an inspection activity using the unit of work session.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-028
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-041
 */
export function createInspectionAuditRepository({ session, model = ActivityLog }) {
  return {
    async append(entry) {
      if (!session?.inTransaction()) throw new Error('Inspection audit requires an active transaction.');
      await model.create([entry], { session });
    },
  };
}
