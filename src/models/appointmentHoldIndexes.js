/**
 * @file appointmentHoldIndexes.js
 * @description The two partial unique indexes that make the database refuse a double booking:
 *
 *   uniq_visit_car_time   one open row per (car, scheduledAt)           — rows with holdsCar: true
 *   uniq_visit_seat_time  one visit per (scheduledAt, seat)             — rows with a numeric visitSeat
 *
 * They are deliberately NOT declared on `AppointmentSchema`: Mongoose `autoIndex` would build
 * them against the real database the first time the server starts (and fail on duplicates).
 * Only `scripts/migrate-appointment-holds.js` creates or drops them, on purpose, after a backup.
 *
 * Ref: .sdd/features/test-drive-capacity-guard/SPEC.md (REQ-213, REQ-221), PLAN.md section 4
 */

export const HOLD_INDEXES = Object.freeze([
  Object.freeze({
    name: 'uniq_visit_car_time',
    key: Object.freeze({ car: 1, scheduledAt: 1 }),
    options: Object.freeze({ unique: true, partialFilterExpression: Object.freeze({ holdsCar: true }) }),
  }),
  Object.freeze({
    name: 'uniq_visit_seat_time',
    key: Object.freeze({ scheduledAt: 1, visitSeat: 1 }),
    options: Object.freeze({
      unique: true,
      partialFilterExpression: Object.freeze({ visitSeat: Object.freeze({ $type: 'number' }) }),
    }),
  }),
]);

const isMissingIndex = (error) => error?.codeName === 'IndexNotFound' || error?.code === 27 || /index not found/i.test(error?.message ?? '');

/**
 * Creates both indexes. `createIndex` is idempotent for an identical definition, so running it
 * again is harmless. Returns the names that were requested.
 *
 * @param {{ createIndex: Function }} collection  A MongoDB collection (e.g. `Appointment.collection`).
 * @returns {Promise<string[]>}
 */
export const ensureHoldIndexes = async (collection) => {
  for (const { name, key, options } of HOLD_INDEXES) {
    await collection.createIndex({ ...key }, { ...options, partialFilterExpression: { ...options.partialFilterExpression }, name });
  }
  return HOLD_INDEXES.map((index) => index.name);
};

/**
 * Drops both indexes, ignoring one that does not exist. Returns the names actually dropped.
 *
 * @param {{ dropIndex: Function }} collection
 * @returns {Promise<string[]>}
 */
export const dropHoldIndexes = async (collection) => {
  const dropped = [];
  for (const { name } of HOLD_INDEXES) {
    try {
      await collection.dropIndex(name);
      dropped.push(name);
    } catch (error) {
      if (!isMissingIndex(error)) throw error;
    }
  }
  return dropped;
};

export default { HOLD_INDEXES, ensureHoldIndexes, dropHoldIndexes };
