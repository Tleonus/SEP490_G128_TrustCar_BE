import mongoose from 'mongoose';
import { InspectionStatus } from '../../constants/appConstants.js';
import InspectionRecord, { openInspectionStatuses, withLifecycleDefaults } from '../../models/InspectionRecord.js';

const recordStatuses = [...openInspectionStatuses, InspectionStatus.SUBMITTED];
const userIdFields = ['inspectorId', 'createdBy', 'updatedBy', 'submittedBy', 'approvedBy', 'rejectedByUserId'];

function toRecord(document) {
  if (!document) return null;
  const { _id, checklistSnapshot, ...record } = withLifecycleDefaults(document);
  const revision = Number(record.checklistVersion);
  if (record.templateKey != null && Number.isSafeInteger(revision) && revision > 0) {
    record.templateRevision = revision;
  }
  if (checklistSnapshot != null) record.templateSnapshot = checklistSnapshot;
  for (const field of userIdFields) {
    if (record[field] != null) record[field] = String(record[field]);
  }
  return { ...record, id: String(_id), carId: String(record.carId) };
}

function checklistVersionFor(revision) {
  if (revision === null) return null;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError('Expected a positive template revision.');
  }
  return String(revision);
}

function toDocument({ id, _id, templateRevision, templateSnapshot, ...fields }) {
  if (id != null) fields._id = id;
  if (templateRevision !== undefined) fields.checklistVersion = checklistVersionFor(templateRevision);
  if (templateSnapshot !== undefined) fields.checklistSnapshot = templateSnapshot;
  return fields;
}

/**
 * Preserve legacy record reads and scope writes to a session and expected status.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-004
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-018
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-035
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-039
 */
export function createInspectionRecordRepository({ session, model = InspectionRecord } = {}) {
  function requireTransaction() {
    if (!session?.inTransaction()) throw new Error('Inspection record writes require an active transaction.');
  }

  return {
    async findById(id) {
      if (!mongoose.isObjectIdOrHexString(id)) return null;
      return toRecord(await model.findById(id, null, { session }).lean());
    },
    async findOpenByCarId(carId) {
      if (!mongoose.isObjectIdOrHexString(carId)) return null;
      return toRecord(await model.findOne(
        { carId, status: { $in: [...openInspectionStatuses] } }, null, { session },
      ).lean());
    },
    async findCertifyingRecord(carId, cpoCertificateId) {
      if (!mongoose.isObjectIdOrHexString(carId) || !cpoCertificateId) return null;
      const record = await model.findOne({
        carId, cpoCertificateId, result: 'PASSED',
        $or: [{ status: InspectionStatus.SUBMITTED }, { status: null }],
      }, '_id templateKey checklistVersion checklistSnapshot.templateKey checklistSnapshot.revision', { session })
        .sort({ createdAt: -1, _id: -1 }).lean();
      if (!record) return null;
      const version = record.checklistSnapshot?.revision ?? record.checklistVersion;
      const revision = version === '1.0' ? 1 : Number(version);
      const hasRevision = (version === '1.0' || /^[1-9]\d*$/.test(String(version))) && Number.isSafeInteger(revision);
      return {
        inspectionId: String(record._id),
        templateKey: record.checklistSnapshot?.templateKey ?? record.templateKey ?? null,
        templateRevision: hasRevision ? revision : null,
      };
    },
    async insert(record) {
      requireTransaction();
      const [saved] = await model.create([toDocument(record)], { session });
      return toRecord(saved);
    },
    async updateIfCurrent(id, expected, changes) {
      requireTransaction();
      if (!mongoose.isObjectIdOrHexString(id) || !recordStatuses.includes(expected?.status)) {
        throw new TypeError('Inspection update requires a record ID and an expected status.');
      }
      const filter = { _id: id, status: expected.status };
      if (expected.templateRevision !== undefined) {
        filter.checklistVersion = checklistVersionFor(expected.templateRevision);
      }
      if (expected.updatedAt !== undefined) {
        if (!(expected.updatedAt instanceof Date) || !Number.isFinite(expected.updatedAt.getTime())) {
          throw new TypeError('Expected a valid inspection update timestamp.');
        }
        filter.updatedAt = expected.updatedAt;
      }
      const { _id, carId, ...fields } = toDocument(changes);
      return toRecord(await model.findOneAndUpdate(
        filter, { $set: fields }, { session, new: true, runValidators: true },
      ).lean());
    },
  };
}
