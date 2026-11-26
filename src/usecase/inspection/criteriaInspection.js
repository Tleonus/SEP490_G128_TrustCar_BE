import { CarStatus } from '../../constants/appConstants.js';
import { InspectionResult } from '../../domain/inspection/criteria.js';
import { InspectionTemplateFormat } from '../../domain/inspection/criterionDefinition.js';

export function isCriteriaTemplate(template) {
  return template?.format === InspectionTemplateFormat.CRITERIA;
}

export function isCertifiedForReinspection(car) {
  return (car.status === CarStatus.APPROVED_CPO || car.status === CarStatus.AVAILABLE) &&
    car.isActive !== false && typeof car.cpoCertificateId === 'string' && car.cpoCertificateId.trim() !== '';
}

// Once the head changes format, a draft finishes against the revision it started with.
export async function findDraftTemplate(templates, record) {
  const current = await templates.findCurrent(record.templateKey);
  if (!isCriteriaTemplate(current) || current.revision === record.templateRevision) return current;
  return templates.findRevision(record.templateKey, record.templateRevision);
}

export function assessCriterionResults(template, results) {
  const byCriterion = new Map(results.map(({ criterionId, outcome }) => [criterionId, outcome]));
  const required = template.groups.filter((group) => group.required);
  return {
    missing: required.filter(({ key }) => !byCriterion.has(key)),
    passed: required.length > 0 && required.every(({ key }) => byCriterion.get(key) === InspectionResult.PASS),
  };
}
