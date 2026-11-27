import { CarStatus, InspectionStatus } from '../../constants/appConstants.js';
import Car from '../../models/Car.js';
import InspectionRecord, { openInspectionStatuses } from '../../models/InspectionRecord.js';

const vehicleFields = {
  vehicleCode: 1, make: 1, model: 1, variant: 1, year: 1, fuelType: 1, mileage: 1,
  status: 1, isActive: 1, updatedAt: 1, cpoCertificateId: 1, listedDate: 1,
};
const queueStockStates = [CarStatus.INCOMING, CarStatus.DRAFT, CarStatus.REJECTED, CarStatus.UNDER_INSPECTION];
const reinspectionStates = [CarStatus.APPROVED_CPO, CarStatus.AVAILABLE];
const withCode = { $type: 'string', $ne: '' };
const escapeSearch = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matchingSearch(search, fields) {
  return search ? { $or: fields.map(field => ({ [field]: { $regex: escapeSearch(search), $options: 'i' } })) } : {};
}

function openInspectionLookup() {
  return { $lookup: {
    from: InspectionRecord.collection.name, localField: '_id', foreignField: 'carId', as: 'openInspection',
    pipeline: [
      { $match: { status: { $in: openInspectionStatuses } } },
      { $sort: { createdAt: -1, _id: -1 } },
      { $limit: 1 },
      { $project: { status: 1, templateKey: 1, checklistVersion: 1 } },
    ],
  } };
}

export function createInspectionListingRepository({ carModel = Car } = {}) {
  async function pageOf(pipeline, { page, limit }) {
    const [result] = await carModel.aggregate([
      ...pipeline,
      { $facet: {
        items: [{ $sort: { updatedAt: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }],
        count: [{ $count: 'total' }],
      } },
    ]);
    const total = result?.count[0]?.total ?? 0;
    return { items: result?.items ?? [], page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  return {
    listQueue(query) {
      const search = matchingSearch(query.search, ['vehicleCode', 'make', 'model', 'variant', 'licensePlate', 'vin']);
      return pageOf([
        { $match: { isActive: true, ...search, status: { $in: [...queueStockStates, ...reinspectionStates] } } },
        openInspectionLookup(),
        { $match: { $or: [
          { status: { $in: queueStockStates } },
          { 'openInspection.0': { $exists: true }, status: { $in: reinspectionStates }, cpoCertificateId: withCode },
        ] } },
        { $set: { openInspection: { $ifNull: [{ $arrayElemAt: ['$openInspection', 0] }, null] } } },
        { $set: { inspectionStatus: { $switch: {
          branches: [
            { case: { $eq: ['$openInspection.status', InspectionStatus.PENDING_APPROVAL] }, then: 'PENDING_APPROVAL' },
            { case: { $eq: ['$openInspection.status', InspectionStatus.DRAFT] }, then: 'IN_PROGRESS' },
            { case: { $eq: ['$status', CarStatus.REJECTED] }, then: 'FAILED' },
            { case: { $eq: ['$status', CarStatus.UNDER_INSPECTION] }, then: 'IN_PROGRESS' },
          ],
          default: 'NEW',
        } } } },
        ...(query.status ? [{ $match: { inspectionStatus: query.status } }] : []),
        { $project: { ...vehicleFields, color: '$specifications.color', inspectionStatus: 1, openInspection: 1 } },
      ], query);
    },
    listCertificates(query) {
      const search = matchingSearch(query.search, ['vehicleCode', 'make', 'model', 'variant', 'cpoCertificateId']);
      return pageOf([
        { $match: { cpoCertificateId: withCode, ...search } },
        { $lookup: {
          from: InspectionRecord.collection.name, as: 'certificateInspection', localField: '_id', foreignField: 'carId',
          let: { code: '$cpoCertificateId' },
          pipeline: [
            { $match: { result: 'PASSED', $or: [{ status: InspectionStatus.SUBMITTED }, { status: null }],
              $expr: { $eq: ['$cpoCertificateId', '$$code'] } } },
            { $sort: { createdAt: -1, _id: -1 } },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
        } },
        { $match: { 'certificateInspection.0': { $exists: true } } },
        { $project: { ...vehicleFields, color: '$specifications.color', hasVerificationQr: {
          $and: [{ $eq: ['$isActive', true] }, { $regexMatch: {
            input: { $convert: { input: '$historyVerifyHash', to: 'string', onNull: '', onError: '' } },
            regex: '^[a-f0-9]{24}$',
          } }],
        }, inspectionId: { $arrayElemAt: ['$certificateInspection._id', 0] } } },
      ], query);
    },
  };
}
