import { Permissions, Roles } from '../../constants/appConstants.js';

function proposalError(code, message) {
  return Object.assign(new Error(message), { code });
}

function canReview(actor) {
  return actor.roleNames.includes(Roles.ADMIN) && actor.permissions.includes(Permissions.INSPECTION_ADMIN);
}

function reader(actor) {
  const reviewer = canReview(actor);
  if (!reviewer && !actor.permissions.includes(Permissions.INSPECTION_WRITE)) {
    throw proposalError('FORBIDDEN', 'Template proposals require inspection write or review access.');
  }
  return { actorId: actor.id, reviewer };
}

const missing = () => proposalError('TEMPLATE_PROPOSAL_NOT_FOUND', 'Template proposal not found.');

/**
 * Route policy authorizes writes. The repository scopes each author mutation to
 * the authenticated owner, and each review to the pending proposal state.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-047
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-048
 */
export function createTemplateProposalUseCases({ templates, unitOfWork }) {
  function transition(id, viewer, write) {
    return unitOfWork.run(async ({ templates: writer }) => {
      const updated = await write(writer);
      if (updated) return updated;
      if (!await writer.findProposal(id, viewer)) throw missing();
      throw proposalError('TEMPLATE_PROPOSAL_STATE_CONFLICT', 'Proposal cannot be changed in this state.');
    });
  }

  return {
    listTemplateProposals(actor, query) {
      return templates.listProposals(reader(actor), query);
    },
    async getTemplateProposal(id, actor) {
      const proposal = await templates.findProposal(id, reader(actor));
      if (!proposal) throw missing();
      return proposal;
    },
    createTemplateProposal(actorId, { templateKey, baseRevision, groups }) {
      return unitOfWork.run(({ templates: writer }) =>
        writer.createProposal({ templateKey, baseRevision, groups, submittedBy: actorId }));
    },
    updateTemplateProposal(id, actorId, changes) {
      return transition(id, { actorId }, (writer) => writer.updateProposalDraft(id, actorId, changes));
    },
    submitTemplateProposal(id, actorId) {
      return transition(id, { actorId }, (writer) => writer.submitProposal(id, actorId));
    },
    returnTemplateProposal(id, actorId, reason) {
      return transition(id, { actorId, reviewer: true }, (writer) => writer.returnProposal(id, actorId, reason));
    },
    approveTemplateProposal(id, actorId) {
      return transition(id, { actorId, reviewer: true }, (writer) => writer.publishProposal(id, actorId));
    },
  };
}
