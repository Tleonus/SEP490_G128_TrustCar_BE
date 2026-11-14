/**
 * @file customerRegistrationService.js
 * @description Self-registration of website customers (CUSTOMER role):
 * - email/password registration
 * - completing an incomplete customer profile
 * (Google sign-in lives in googleSignInService.js and reuses these helpers.)
 * - linking an account to the showroom Customer profile
 *
 * Sessions are issued exactly like a KAN-9 login (authTokens.js).
 * This layer contains ZERO Express req/res references.
 */

import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Role from '../models/Role.js';
import ActivityLog from '../models/ActivityLog.js';
import { AppError } from '../utils/apiResponse.js';
import { signAccessToken, signRefreshToken } from '../utils/authTokens.js';
import { ActivityEventType, Roles } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';

const CUSTOMER_SOURCE_WEBSITE = 'WEBSITE';

export const appError = (msg) => new AppError(msg.message, msg.httpStatus, msg.code);

/**
 * Converts a MongoDB duplicate-key error (concurrent registration) into the
 * matching business error; any other error is returned unchanged.
 */
export const mapDuplicateKeyError = (error) => {
  if (error?.code !== 11000) return error;
  const field = Object.keys(error.keyPattern || {})[0];
  if (field === 'email') return appError(MSG.MSG18);
  if (field === 'firebaseUid') return appError(MSG.MSG72);
  // phone, or the linked Customer (only reachable through the same phone)
  return appError(MSG.MSG69);
};

/** Resolves the CUSTOMER role document (seeded at startup). */
export const resolveCustomerRole = async () => {
  const role = await Role.findOne({ name: Roles.CUSTOMER, isActive: true });
  if (!role) throw appError(MSG.MSG63);
  return role;
};

/**
 * Finds the showroom Customer to link a customer account to, or creates one.
 * Links only when exactly one active Customer has this phone and no account
 * is linked to it yet; otherwise a new Customer (source WEBSITE) is created so
 * staff can merge duplicates later. An existing Customer is never modified
 * (not even an empty email): the phone is not verified, so the registrant may
 * not be the real customer and must not be able to redirect staff contact.
 *
 * @param {{ fullName: string, phone: string, email: string }} profile
 * @returns {Promise<{ customerId: object, created: boolean }>}
 */
export const findOrCreateCustomer = async ({ fullName, phone, email }) => {
  const candidates = await Customer.find({ phone, isActive: true }).select('_id').lean();

  if (candidates.length === 1) {
    const [candidate] = candidates;
    const alreadyLinked = await User.exists({ customer: candidate._id });
    if (!alreadyLinked) {
      return { customerId: candidate._id, created: false };
    }
  }

  const customer = await Customer.create({ fullName, phone, email, source: CUSTOMER_SOURCE_WEBSITE });
  return { customerId: customer._id, created: true };
};

/** Removes a Customer created for an account whose save then failed. */
export const rollbackCustomerLink = async (link) => {
  if (link?.created) await Customer.deleteOne({ _id: link.customerId });
};

/** Issues a KAN-9 session for a saved user document (tokenVersion loaded or default). */
export const issueSession = (user) => ({
  user:         user.toSafeObject(),
  accessToken:  signAccessToken(user),
  refreshToken: signRefreshToken(user),
});

/**
 * Registers a customer with email + password and logs them in.
 * Ref: REQ-001…005, REQ-020, REQ-028
 *
 * @param {object} params
 * @param {string} params.email
 * @param {string} params.password
 * @param {string} params.fullName
 * @param {string} params.phone - normalised 0xxxxxxxxx
 * @param {string} [params.ipAddress]
 * @param {string} [params.userAgent]
 * @returns {Promise<{ user: object, accessToken: string, refreshToken: string }>}
 */
export const register = async ({ email, password, fullName, phone, ipAddress, userAgent }) => {
  const normalizedEmail = email.toLowerCase();

  if (await User.exists({ email: normalizedEmail })) throw appError(MSG.MSG18);
  if (await User.exists({ roleName: Roles.CUSTOMER, phone })) throw appError(MSG.MSG69);

  const role = await resolveCustomerRole();
  const link = await findOrCreateCustomer({ fullName, phone, email: normalizedEmail });

  let user;
  try {
    user = await User.create({
      fullName,
      email:    normalizedEmail,
      password, // hashed by the pre-save hook
      phone,
      role:     role._id,
      roleName: Roles.CUSTOMER,
      customer: link.customerId,
    });
  } catch (error) {
    await rollbackCustomerLink(link);
    throw mapDuplicateKeyError(error);
  }

  await ActivityLog.log({
    eventType:        ActivityEventType.CUSTOMER_REGISTERED,
    performedBy:      user._id,
    performedByEmail: user.email,
    targetModel:      'User',
    targetId:         user._id,
    summary:          `Customer self-registered with email${link.created ? '' : ' (linked to existing customer profile)'}`,
    ipAddress,
    userAgent,
  });

  return issueSession(user);
};

/** Fields needed to evaluate and update a customer account. */
export const ACCOUNT_FIELDS = '+password +tokenVersion +firebaseUid';

const PROFILE_FIELDS = ['fullName', 'phone', 'password'];

/**
 * Completes an incomplete customer profile with exactly the missing fields,
 * then links the account to a Customer (once the phone is known).
 * The current session stays valid.
 * Ref: REQ-017…019, REQ-020, REQ-028
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {{ fullName?: string, phone?: string, password?: string }} params.fields
 * @param {string} [params.ipAddress]
 * @param {string} [params.userAgent]
 * @returns {Promise<object>} Safe user object with profile status.
 */
export const completeProfile = async ({ userId, fields, ipAddress, userAgent }) => {
  const user = await User.findById(userId).select(ACCOUNT_FIELDS);
  if (!user) throw appError(MSG.MSG17);

  const { missingFields } = user.profileStatus();
  const provided = PROFILE_FIELDS.filter((f) => fields[f] !== undefined);
  const sameSet = provided.length === missingFields.length && provided.every((f) => missingFields.includes(f));
  if (!sameSet) {
    throw new AppError(
      missingFields.length === 0
        ? 'Profile is already complete.'
        : `Provide exactly the missing fields: ${missingFields.join(', ')}.`,
      MSG.MSG42.httpStatus,
      MSG.MSG42.code
    );
  }

  if (fields.phone && await User.exists({ roleName: Roles.CUSTOMER, phone: fields.phone, _id: { $ne: user._id } })) {
    throw appError(MSG.MSG69);
  }

  provided.forEach((f) => { user[f] = fields[f]; }); // password hashed by the pre-save hook

  let link = null;
  if (fields.phone && !user.customer) {
    link = await findOrCreateCustomer({ fullName: user.fullName, phone: user.phone, email: user.email });
    user.customer = link.customerId;
  }

  try {
    await user.save();
  } catch (error) {
    await rollbackCustomerLink(link);
    throw mapDuplicateKeyError(error);
  }

  await ActivityLog.log({
    eventType:        ActivityEventType.PROFILE_COMPLETED,
    performedBy:      user._id,
    performedByEmail: user.email,
    targetModel:      'User',
    targetId:         user._id,
    summary:          `Customer profile updated: ${provided.join(', ')}`,
    ipAddress,
    userAgent,
  });

  return user.toSafeObject();
};

export default { register, completeProfile };
