/**
 * Plain data contract for reading a single public CPO report. The adapter
 * selects these fields and converts stored references to ObjectId strings.
 *
 * @typedef {{ kind: 'id' | 'vehicleCode', value: string }} CarLookup
 *
 * @typedef {object} ReportVehicleInfo
 * @property {string|null} [make]
 * @property {string|null} [model]
 * @property {string|null} [variant]
 * @property {string|null} [color]
 * @property {number|null} [year]
 * @property {number|null} [mileage]
 *
 * @typedef {ReportVehicleInfo & { id: string, isActive: boolean, status: string, cpoCertificateId?: string|null }} ReportCar
 *
 * @typedef {object} CertifyingInspection
 * @property {string} carId
 * @property {string} cpoCertificateId
 * @property {string|null} [status] Missing for legacy records.
 * @property {string|null} [source]
 * @property {string} result
 * @property {Partial<Record<string, boolean>>} [criteria] The five fixed result fields.
 * @property {{key: string, label: string, passed: true}[]} [criteriaGroups] Passed criteria from the certifying revision.
 * @property {string|null} [inspectorName] Present when the revision query already loaded the inspector.
 * @property {ReportVehicleInfo|null} [confirmedVehicle]
 * @property {number|null} [odo]
 * @property {Date|string|null} [submittedAt]
 * @property {Date|string|null} [createdAt]
 * @property {string|null} [submittedBy]
 * @property {string|null} [inspectorId]
 *
 * @typedef {object} InspectionReportReader
 * @property {(lookup: CarLookup) => Promise<ReportCar|null>} findCar
 *   Reads at most one active car for the exact lookup key.
 * @property {(carId: string, certificateId: string) => Promise<CertifyingInspection|null>} findCertifyingInspection
 *   Matches the car and certificate and selects a finalized, passing record.
 *   Missing status is treated as final for legacy records.
 * @property {(inspectorId: string) => Promise<string|null>} findInspectorName
 *   Reads only the fullName of the selected inspector, if present.
 */
export {};
