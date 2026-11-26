/**
 * Inbound values and repository results use plain data. A repository obtained
 * inside a unit of work participates in the same transaction as the others.
 *
 * @typedef {'ELECTRIC' | 'GASOLINE'} TemplateKey
 * @typedef {'DRAFT' | 'PENDING_APPROVAL' | 'SUBMITTED'} InspectionState
 * @typedef {string | number | string[]} AnswerValue
 * @typedef {{ questionId: string, value: AnswerValue }} DraftAnswer
 * @typedef {DraftAnswer & { sourceRevision: number | null }} ArchivedAnswer
 * @typedef {{ questionId: string, optionId: string }} RetiredOption
 * @typedef {{ questions: string[], options: RetiredOption[] }} RetiredIds
 *
 * @typedef {object} FormTemplate
 * @property {TemplateKey} templateKey
 * @property {number} revision
 * @property {'QUESTIONNAIRE' | 'CRITERIA'} [format]
 * @property {object[]} groups
 * @property {RetiredIds} retiredIds
 *
 * @typedef {object} InspectionRecord
 * @property {string} id
 * @property {string} carId
 * @property {InspectionState} status Status normalized for older records.
 * @property {TemplateKey | null} [templateKey]
 * @property {number | null} [templateRevision]
 * @property {DraftAnswer[]} [answers]
 * @property {ArchivedAnswer[]} [archivedAnswers]
 * @property {FormTemplate} [templateSnapshot]
 *
 * @typedef {object} InspectionCar
 * @property {string} id
 * @property {string} fuelType
 * @property {string} status
 */

/**
 * @typedef {object} FormTemplateRepository
 * @property {(key: TemplateKey) => Promise<FormTemplate | null>} findCurrent
 * @property {(key: TemplateKey, revision: number) => Promise<FormTemplate | null>} findRevision
 * @property {(template: FormTemplate, baseRevision: number, actorId: string) => Promise<FormTemplate | null>} publish
 *   Atomically writes an immutable revision and advances the current pointer.
 *   Returns null on revision conflict.
 * @property {(id: string, viewer: {actorId: string, reviewer?: boolean}) => Promise<object | null>} findProposal
 * @property {(viewer: {actorId: string, reviewer?: boolean}, query: object) => Promise<{items: object[], nextCursor: string | null}>} listProposals
 * @property {(draft: object) => Promise<object>} createProposal
 * @property {(id: string, actorId: string, changes: object) => Promise<object | null>} updateProposalDraft
 * @property {(id: string, actorId: string) => Promise<object | null>} submitProposal
 * @property {(id: string, actorId: string, reason: string) => Promise<object | null>} returnProposal
 * @property {(id: string, actorId: string) => Promise<FormTemplate | null>} publishProposal
 *
 * @typedef {object} InspectionRecordRepository
 * @property {(id: string) => Promise<InspectionRecord | null>} findById
 * @property {(carId: string) => Promise<InspectionRecord | null>} findOpenByCarId
 *   Open states are DRAFT and PENDING_APPROVAL.
 * @property {(carId: string, certificateId: string) => Promise<{inspectionId: string, templateKey: TemplateKey | null, templateRevision: number | null} | null>} findCertifyingRecord
 * @property {(record: object) => Promise<InspectionRecord>} insert
 * @property {(id: string, expected: Partial<InspectionRecord>, changes: object) => Promise<InspectionRecord | null>} updateIfCurrent
 *   Returns null when the stored state no longer matches the supplied conditions.
 *
 * @typedef {object} InspectionCarRepository
 * @property {(id: string) => Promise<InspectionCar | null>} findById
 * @property {(id: string, expected: Partial<InspectionCar>) => Promise<InspectionCar | null>} claimForInspection
 *   Serializes draft creation and quick inspection for the car in the unit of work.
 * @property {(id: string, expected: Partial<InspectionCar>, changes: object) => Promise<InspectionCar | null>} updateIfCurrent
 *
 * @typedef {object} InspectionAuditRepository
 * @property {(entry: object) => Promise<void>} append
 *
 * @typedef {object} InspectionRepositories
 * @property {FormTemplateRepository} templates
 * @property {InspectionRecordRepository} records
 * @property {InspectionCarRepository} cars
 * @property {InspectionAuditRepository} audit
 *
 * @typedef {object} InspectionUnitOfWork
 * @property {<Result>(action: (repositories: InspectionRepositories) => Promise<Result>) => Promise<Result>} run
 *   Reverts all writes when action rejects.
 */

export {};
