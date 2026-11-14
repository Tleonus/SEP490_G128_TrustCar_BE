/**
 * @file withTransaction.js
 * @description Runs a unit of work inside one MongoDB transaction: every write
 * made with the provided session is committed together or rolled back together.
 *
 * Usage:
 *   const result = await withTransaction(async (session) => {
 *     await Model.create([doc], { session });
 *     await other.save({ session });
 *     return something;
 *   });
 */

import mongoose from 'mongoose';

/**
 * @template T
 * @param {(session: import('mongoose').ClientSession) => Promise<T>} work
 * @returns {Promise<T>} the value returned by `work`, after commit
 */
export const withTransaction = async (work) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await work(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
};

export default withTransaction;
