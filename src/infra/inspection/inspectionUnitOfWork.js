import { withTransaction } from '../../utils/withTransaction.js';
import { createFormTemplateRepository } from './formTemplateRepository.js';
import { createInspectionAuditRepository } from './inspectionAuditRepository.js';

/**
 * Bind the available inspection repositories to one MongoDB transaction.
 * The callback performs repository work only and can be replayed once if the
 * driver reports a transient transaction conflict.
 */
export function createInspectionUnitOfWork({
  runTransaction = withTransaction,
  bindTemplates = (session) => createFormTemplateRepository({ session }),
  bindAudit = (session) => createInspectionAuditRepository({ session }),
  bindRecords,
  bindCars,
} = {}) {
  return {
    async run(action) {
      const execute = () => runTransaction((session) => action({
        templates: bindTemplates(session),
        audit: bindAudit(session),
        records: bindRecords?.(session),
        cars: bindCars?.(session),
      }));
      try {
        return await execute();
      } catch (error) {
        // A competing writer can abort a transaction before it sees the new head.
        // The second attempt sees the committed revision and returns the CAS result.
        if (!error?.hasErrorLabel?.('TransientTransactionError')) throw error;
        return execute();
      }
    },
  };
}
