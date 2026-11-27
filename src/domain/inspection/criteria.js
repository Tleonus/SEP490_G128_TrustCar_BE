/**
 * Fixed criterion identities shared by both inspection templates.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-040
 */
export const CPO_CRITERIA = Object.freeze([
  { key: 'G1_BODY_FRAME', criteriaKey: 'noMajorAccident', label: 'Khung gầm, thân vỏ không đâm va' },
  { key: 'G2_FLOOD', criteriaKey: 'noWaterDamage', label: 'Không ngập nước, thủy kích' },
  { key: 'G3_ENGINE_GEARBOX', criteriaKey: 'engineGearboxIntact', label: 'Động cơ, hộp số nguyên bản' },
  { key: 'G4_ODOMETER', criteriaKey: 'verifiedOdo', label: 'ODO chuẩn, không tua' },
  { key: 'G5_ELECTRICAL_SAFETY', criteriaKey: 'electricalSystemPassed', label: 'Điện tử, an toàn hoạt động tốt' },
].map((criterion) => Object.freeze(criterion)));

export const InspectionResult = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_CHECKABLE: 'NOT_CHECKABLE',
});

/** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-026 */
export const evaluateCpo = (criteria) => criteria != null && CPO_CRITERIA.every(
  ({ criteriaKey }) => Object.hasOwn(criteria, criteriaKey) && criteria[criteriaKey] === true,
);
