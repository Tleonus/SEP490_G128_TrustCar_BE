import { describe, expect, jest, test } from '@jest/globals';
import mongoose from 'mongoose';
import { CarStatus, FuelType, InspectionStatus } from '../src/constants/appConstants.js';
import InspectionRecord, { openInspectionIndex, openInspectionStatuses } from '../src/models/InspectionRecord.js';
import { createInspectionCarRepository } from '../src/infra/inspection/inspectionCarRepository.js';
import { createInspectionRecordRepository } from '../src/infra/inspection/inspectionRecordRepository.js';
import { createInspectionUnitOfWork } from '../src/infra/inspection/inspectionUnitOfWork.js';

const carId = '000000000000000000000001';
const inspectionId = '000000000000000000000002';
const userId = '000000000000000000000003';
const pendingApproval = 'PENDING_APPROVAL';
const whenSubmitted = new Date('2026-11-20T09:00:00.000Z');
const activeSession = { inTransaction: () => true };
const lean = (value) => ({ lean: async () => value });

const snapshot = {
  templateKey: 'ELECTRIC',
  revision: 3,
  groups: [{ key: 'G1_BODY_FRAME', questions: [] }],
  retiredIds: { questions: ['old'], options: [] },
};
const pendingDocument = {
  carId, status: pendingApproval, source: 'STAFF', templateKey: 'ELECTRIC',
  inspectorId: userId, submittedBy: userId, submittedAt: whenSubmitted,
  checklistVersion: '3', checklistSnapshot: snapshot,
  answers: [{ questionId: 'odo', value: 0 }],
  archivedAnswers: [{ questionId: 'old', value: 'previous answer', sourceRevision: 2 }],
};

describe('Inspection record schema', () => {
  test('stores a submission snapshot and empty verdict before approval', async () => {
    const pending = new InspectionRecord(pendingDocument);
    await expect(pending.validate()).resolves.toBeUndefined();
    expect(pending.toObject()).toMatchObject({
      status: pendingApproval, checklistSnapshot: snapshot,
      answers: pendingDocument.answers, archivedAnswers: pendingDocument.archivedAnswers,
    });
    expect(pending.criteria).toBeUndefined();
    expect(pending.result).toBeUndefined();
    expect(pending.odo).toBeUndefined();
  });

  test('requires submission metadata in pending status and the verdict in final status', () => {
    const pending = new InspectionRecord({ carId, status: pendingApproval });
    const final = new InspectionRecord({ carId, status: InspectionStatus.SUBMITTED, inspectorId: userId });
    expect(Object.keys(pending.validateSync().errors)).toEqual(expect.arrayContaining([
      'templateKey', 'checklistVersion', 'checklistSnapshot', 'inspectorId', 'submittedBy', 'submittedAt',
    ]));
    expect(Object.keys(final.validateSync().errors)).toEqual(expect.arrayContaining(['criteria', 'odo', 'result']));
    expect(new InspectionRecord({ carId, status: InspectionStatus.DRAFT, checklistVersion: 'v1' })
      .validateSync()).toBeUndefined();
  });

  test('defines the rollout index for exactly both open states and retains the registered draft index', () => {
    expect(openInspectionIndex).toEqual({
      key: { carId: 1 },
      options: {
        name: 'uniq_open_inspection_per_car',
        unique: true,
        partialFilterExpression: { status: { $in: [InspectionStatus.DRAFT, pendingApproval] } },
      },
    });
    expect(InspectionRecord.schema.indexes().map(([, options]) => options.name))
      .toContain('uniq_draft_per_car');
    expect(InspectionRecord.schema.indexes().map(([, options]) => options.name))
      .not.toContain(openInspectionIndex.options.name);
  });
});

describe('Inspection record repository', () => {
  test('reads legacy records as final and queries only open statuses in the assigned session', async () => {
    const objectId = (value) => new mongoose.Types.ObjectId(value);
    const model = {
      findById: jest.fn(() => lean({ _id: objectId(inspectionId), carId: objectId(carId), checklistVersion: 'v1' })),
      findOne: jest.fn(() => lean({ ...pendingDocument, _id: objectId(inspectionId) })),
    };
    const repository = createInspectionRecordRepository({ session: activeSession, model });
    await expect(repository.findById(inspectionId)).resolves.toEqual({
      id: inspectionId, carId, status: InspectionStatus.SUBMITTED, source: 'LEGACY', checklistVersion: 'v1',
    });
    await expect(repository.findOpenByCarId(carId)).resolves.toMatchObject({
      id: inspectionId, carId, status: pendingApproval, templateRevision: 3, templateSnapshot: snapshot,
    });
    expect(model.findOne).toHaveBeenCalledWith(
      { carId, status: { $in: [...openInspectionStatuses] } }, null, { session: activeSession },
    );
  });

  test('maps the port revision and snapshot into the persisted checklist fields', async () => {
    const model = {
      create: jest.fn(async ([record]) => [new InspectionRecord(record)]),
    };
    const repository = createInspectionRecordRepository({ session: activeSession, model });
    const {
      checklistVersion, checklistSnapshot, ...formFields
    } = pendingDocument;
    const saved = await repository.insert({
      ...formFields, id: inspectionId, templateRevision: 3, templateSnapshot: snapshot,
    });
    expect(model.create).toHaveBeenCalledWith([{
      ...formFields, _id: inspectionId, checklistVersion, checklistSnapshot,
    }], { session: activeSession });
    expect(saved).toMatchObject({ id: inspectionId, templateRevision: 3, templateSnapshot: snapshot });
  });

  test('matches expected status, revision and timestamp on updates and returns null for a stale transition', async () => {
    const model = {
      findOneAndUpdate: jest.fn()
        .mockReturnValueOnce(lean({ ...pendingDocument, _id: inspectionId, status: InspectionStatus.DRAFT }))
        .mockReturnValueOnce(lean(null)),
    };
    const repository = createInspectionRecordRepository({ session: activeSession, model });
    const expected = { status: pendingApproval, templateRevision: 3, updatedAt: whenSubmitted };
    const changes = { status: InspectionStatus.DRAFT, templateSnapshot: null, carId: userId };
    await expect(repository.updateIfCurrent(inspectionId, expected, changes)).resolves.toMatchObject({
      id: inspectionId, status: InspectionStatus.DRAFT, carId,
    });
    await expect(repository.updateIfCurrent(inspectionId, expected, changes)).resolves.toBeNull();
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: inspectionId, status: pendingApproval, checklistVersion: '3', updatedAt: whenSubmitted },
      { $set: { status: InspectionStatus.DRAFT, checklistSnapshot: null } },
      { session: activeSession, new: true, runValidators: true },
    );
  });

  test('rejects writes without a transaction and refuses to use an operator as an expected status', async () => {
    const model = { create: jest.fn(), findOneAndUpdate: jest.fn() };
    await expect(createInspectionRecordRepository({ model }).insert(pendingDocument))
      .rejects.toThrow('active transaction');
    const repository = createInspectionRecordRepository({ session: activeSession, model });
    await expect(repository.updateIfCurrent(inspectionId, { status: { $ne: 'DRAFT' } }, {}))
      .rejects.toThrow(TypeError);
    expect(model.create).not.toHaveBeenCalled();
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

const carRow = () => ({
  _id: carId, status: CarStatus.UNDER_INSPECTION, fuelType: FuelType.ELECTRIC,
  updatedAt: new Date('2090-11-21T09:00:00.000Z'),
  specifications: { color: 'White' }, mileage: 15,
});

function matchesCar(row, filter) {
  return row._id === filter._id && row.status === filter.status && row.fuelType === filter.fuelType &&
    row.updatedAt?.getTime() === filter.updatedAt?.getTime();
}

describe('Inspection vehicle write guard', () => {
  test('advances the timestamp, permits one claim from the same observed state and ignores unrelated changes', async () => {
    let row = carRow();
    const model = {
      findById: jest.fn(() => lean(row)),
      findOneAndUpdate: jest.fn((filter, { $set }) => {
        if (!matchesCar(row, filter)) return lean(null);
        row = { ...row, ...$set };
        return lean(row);
      }),
    };
    const repository = createInspectionCarRepository({ session: activeSession, model });
    const observed = await repository.findById(carId);
    expect(observed).toMatchObject({ id: carId, color: 'White', fuelType: FuelType.ELECTRIC });
    const [draftClaim, quickClaim] = await Promise.all([
      repository.claimForInspection(carId, observed),
      repository.claimForInspection(carId, observed),
    ]);
    expect(draftClaim.updatedAt.getTime()).toBe(observed.updatedAt.getTime() + 1);
    expect(quickClaim).toBeNull();
    expect(model.findOneAndUpdate).toHaveBeenNthCalledWith(1, {
      _id: carId, status: CarStatus.UNDER_INSPECTION, fuelType: FuelType.ELECTRIC, updatedAt: observed.updatedAt,
    }, { $set: { updatedAt: draftClaim.updatedAt } }, expect.objectContaining({
      session: activeSession, timestamps: false, new: true, runValidators: true,
    }));
    const updated = await repository.updateIfCurrent(carId, draftClaim, {
      status: CarStatus.APPROVED_CPO, mileage: 20, fuelType: FuelType.GASOLINE,
    });
    expect(updated).toMatchObject({ status: CarStatus.APPROVED_CPO, mileage: 20, fuelType: FuelType.ELECTRIC });
  });

  test('aborts the vehicle claim when the record write fails in the same unit of work', async () => {
    let committed = carRow();
    const session = {
      startTransaction: jest.fn(), inTransaction: () => true, workingCar: { ...committed },
      commitTransaction: jest.fn(() => { committed = session.workingCar; }),
      abortTransaction: jest.fn(),
      endSession: jest.fn(),
    };
    const startSession = jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    const carModel = {
      findById: jest.fn(() => lean(session.workingCar)),
      findOneAndUpdate: jest.fn((_filter, { $set }) => {
        session.workingCar = { ...session.workingCar, ...$set };
        return lean(session.workingCar);
      }),
    };
    const recordModel = { create: jest.fn().mockRejectedValue(new Error('Failed insert.')) };
    try {
      const unitOfWork = createInspectionUnitOfWork({
        bindCars: (transaction) => createInspectionCarRepository({ session: transaction, model: carModel }),
        bindRecords: (transaction) => createInspectionRecordRepository({ session: transaction, model: recordModel }),
      });
      await expect(unitOfWork.run(async ({ cars, records }) => {
        await cars.claimForInspection(carId, await cars.findById(carId));
        await records.insert({ carId, status: InspectionStatus.DRAFT });
      })).rejects.toThrow('Failed insert.');
      expect(carModel.findOneAndUpdate.mock.calls[0][2].session).toBe(session);
      expect(recordModel.create.mock.calls[0][1].session).toBe(session);
      expect(session.abortTransaction).toHaveBeenCalledTimes(1);
      expect(session.commitTransaction).not.toHaveBeenCalled();
      expect(committed.updatedAt).toEqual(carRow().updatedAt);
    } finally {
      startSession.mockRestore();
    }
  });
});
