/**
 * @file appointment-hold-indexes.test.js
 * @description The hold fields exist without defaults, and the two unique indexes are defined
 * outside the schema (so `autoIndex` can never build them on the real database).
 *
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-213
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-220
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-221
 */

import mongoose from 'mongoose';
import Appointment from '../src/models/Appointment.js';
import { HOLD_INDEXES, ensureHoldIndexes, dropHoldIndexes } from '../src/models/appointmentHoldIndexes.js';

const { ObjectId } = mongoose.Types;
const validRow = () => ({
  customer: new ObjectId(), car: new ObjectId(), type: 'TEST_DRIVE', scheduledAt: new Date('2030-01-01T03:00:00Z'),
  createdBy: new ObjectId(), appointmentCode: 'APT-0001',
});

const fakeCollection = () => {
  const calls = { created: [], dropped: [] };
  const existing = new Set();
  return {
    calls,
    existing,
    createIndex: async (key, options) => { calls.created.push({ key, options }); existing.add(options.name); },
    dropIndex: async (name) => {
      if (!existing.has(name)) { const error = new Error('index not found with name [x]'); error.codeName = 'IndexNotFound'; throw error; }
      existing.delete(name); calls.dropped.push(name);
    },
  };
};

describe('Appointment hold fields (REQ-220)', () => {
  test('a new row has neither holdsCar nor visitSeat by default', () => {
    const row = new Appointment(validRow());
    expect(row.holdsCar).toBeUndefined();
    expect(row.visitSeat).toBeUndefined();
    expect(row.toObject()).not.toHaveProperty('holdsCar');
    expect(row.toObject()).not.toHaveProperty('visitSeat');
  });

  test('visitSeat must be at least 1', () => {
    const error = new Appointment({ ...validRow(), visitSeat: 0 }).validateSync();
    expect(error?.errors?.visitSeat).toBeDefined();
    expect(new Appointment({ ...validRow(), visitSeat: 1, holdsCar: true }).validateSync()?.errors?.visitSeat).toBeUndefined();
  });
});

describe('hold indexes are not part of the schema (REQ-221, AC-36)', () => {
  test('the schema never declares the two new indexes', () => {
    const names = Appointment.schema.indexes().map(([, options]) => options?.name);
    expect(names).not.toContain('uniq_visit_car_time');
    expect(names).not.toContain('uniq_visit_seat_time');
  });

  test('the schema keeps no index on the new fields at all', () => {
    const keys = Appointment.schema.indexes().flatMap(([key]) => Object.keys(key));
    expect(keys).not.toContain('holdsCar');
    expect(keys).not.toContain('visitSeat');
  });
});

describe('HOLD_INDEXES / ensureHoldIndexes (REQ-213)', () => {
  test('defines exactly the two partial unique indexes', () => {
    expect(HOLD_INDEXES.map((index) => index.name)).toEqual(['uniq_visit_car_time', 'uniq_visit_seat_time']);
    expect(HOLD_INDEXES[0].key).toEqual({ car: 1, scheduledAt: 1 });
    expect(HOLD_INDEXES[0].options).toMatchObject({ unique: true, partialFilterExpression: { holdsCar: true } });
    expect(HOLD_INDEXES[1].key).toEqual({ scheduledAt: 1, visitSeat: 1 });
    expect(HOLD_INDEXES[1].options).toMatchObject({ unique: true, partialFilterExpression: { visitSeat: { $type: 'number' } } });
  });

  test('ensureHoldIndexes creates both with the right key, filter and name', async () => {
    const collection = fakeCollection();
    const names = await ensureHoldIndexes(collection);
    expect(names).toEqual(['uniq_visit_car_time', 'uniq_visit_seat_time']);
    expect(collection.calls.created).toEqual([
      { key: { car: 1, scheduledAt: 1 }, options: { unique: true, partialFilterExpression: { holdsCar: true }, name: 'uniq_visit_car_time' } },
      { key: { scheduledAt: 1, visitSeat: 1 }, options: { unique: true, partialFilterExpression: { visitSeat: { $type: 'number' } }, name: 'uniq_visit_seat_time' } },
    ]);
  });

  test('running ensureHoldIndexes twice is harmless', async () => {
    const collection = fakeCollection();
    await ensureHoldIndexes(collection);
    await ensureHoldIndexes(collection);
    expect(collection.existing.size).toBe(2);
  });

  test('dropHoldIndexes drops what exists and ignores what does not', async () => {
    const collection = fakeCollection();
    await ensureHoldIndexes(collection);
    expect(await dropHoldIndexes(collection)).toEqual(['uniq_visit_car_time', 'uniq_visit_seat_time']);
    expect(await dropHoldIndexes(collection)).toEqual([]);
  });

  test('dropHoldIndexes does not swallow other errors', async () => {
    const collection = { dropIndex: async () => { throw new Error('connection lost'); } };
    await expect(dropHoldIndexes(collection)).rejects.toThrow('connection lost');
  });
});
