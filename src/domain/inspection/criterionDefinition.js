export const InspectionTemplateFormat = Object.freeze({
  QUESTIONNAIRE: 'QUESTIONNAIRE',
  CRITERIA: 'CRITERIA',
});

export const TemplateProposalStatus = Object.freeze({
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

export const criterionKeyPattern = /^[A-Za-z0-9_-]+$/;
export const criterionKeyMaxLength = 120;

export function isCriterionKey(key) {
  return typeof key === 'string' && key === key.trim() &&
    key.length <= criterionKeyMaxLength && criterionKeyPattern.test(key);
}

/**
 * Validate the flat groups of a CRITERIA revision.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#req-047
 */
export function collectCriterionDefinitionIssues(groups) {
  if (!Array.isArray(groups) || !groups.length) {
    return [{ field: 'groups', message: 'Provide at least one criterion.' }];
  }

  const issues = [];
  const keys = new Set();
  for (const [index, criterion] of groups.entries()) {
    const field = `groups.${index}`;
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) {
      issues.push({ field, message: 'Provide a criterion object.' });
      continue;
    }
    const { key, label, required } = criterion;
    if (!isCriterionKey(key)) {
      issues.push({ field: `${field}.key`, message: 'Invalid criterion key.' });
    } else if (keys.has(key)) {
      issues.push({ field: `${field}.key`, message: 'Criterion keys must be unique.' });
    } else {
      keys.add(key);
    }
    if (typeof label !== 'string' || !label.trim()) {
      issues.push({ field: `${field}.label`, message: 'Provide a criterion label.' });
    }
    if (typeof required !== 'boolean') {
      issues.push({ field: `${field}.required`, message: 'Required must be a boolean.' });
    }
  }
  if (issues.length === 0 && !groups.some(({ required }) => required)) {
    issues.push({ field: 'groups', message: 'At least one criterion must be required.' });
  }
  return issues;
}
