/**
 * @file profileWrite.js
 * @description Writes a profile change to the two records that hold it, keeping them equal.
 *
 * Order: User first, Customer second, and if the second write fails the User is put back to
 * its old values (compensation). Why this order: the unique customer phone index lives on
 * `User`, so a phone taken by someone else is refused by the FIRST write and nothing has
 * changed yet; only a failure of the second write needs undoing. No transaction on purpose
 * (the repository does not use them; same approach as `rollbackCustomerLink` in
 * customerRegistrationService).
 *
 * Never `user.save()`: it would run every validator and hook of `User` (e.g. the password
 * hash) for a change that touches two name fields. `updateOne` with `$set` writes only what changed.
 *
 * Ref: .sdd/features/user-profile-settings/SPEC.md (REQ-008, 009, 010; C14)
 */

import User from '../models/User.js';
import Customer from '../models/Customer.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { AppError } from '../utils/apiResponse.js';
import { appError, mapDuplicateKeyError } from './customerRegistrationService.js';

const hasKeys = (object) => Object.keys(object).length > 0;

/** The values of `fields` as they are now, so they can be written back. */
const previousValues = (user, fields) => Object.fromEntries(Object.keys(fields).map((key) => [key, user[key]]));

/**
 * Puts the User back after a failed Customer write. A failure here is only reported (without any
 * personal data); the caller still answers with the original failure.
 */
const restoreUser = async (userId, before) => {
  try {
    await User.updateOne({ _id: userId }, { $set: before });
  } catch (error) {
    console.error('Profile compensation failed for user', String(userId), error.code ?? error.name);
  }
};

/**
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-008
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-009
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-010
 * @param {{ user: object, customer: object|null, diff: { userFields: object, customerFields: object }, actorId: * }} p
 * @throws {AppError} 409 PHONE_ALREADY_EXISTS when the phone is taken (first write), 404 when the
 *   Customer vanished, 500 (after restoring the User) when the Customer write failed.
 */
export const writeProfile = async ({ user, customer, diff, actorId }) => {
  const { userFields, customerFields } = diff;
  const before = previousValues(user, userFields);

  if (hasKeys(userFields)) {
    try {
      await User.updateOne({ _id: user._id }, { $set: userFields });
    } catch (error) {
      throw mapDuplicateKeyError(error); // a phone taken meanwhile: 409, nothing was written
    }
  }
  if (!hasKeys(customerFields) || customer === null) return;

  try {
    const result = await Customer.updateOne({ _id: customer._id }, { $set: { ...customerFields, updatedBy: actorId } });
    if (result.matchedCount === 0) throw appError(MSG.MSG31);
  } catch (error) {
    if (hasKeys(before)) await restoreUser(user._id, before);
    if (error instanceof AppError) throw error;
    throw new AppError(MSG.MSG62.message, MSG.MSG62.httpStatus, MSG.MSG62.code);
  }
};

export default { writeProfile };
