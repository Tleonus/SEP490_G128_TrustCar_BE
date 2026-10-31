/**
 * @file user-profile-status.test.js
 * @description User model rules introduced for customer self-registration:
 * conditional required fields, profile completeness, unique constraints and
 * safe serialisation. Uses the in-memory persistence harness (no MongoDB).
 */

import mongoose from 'mongoose';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
const { User } = h;

beforeEach(() => h.reset());

const isDuplicate = (error, field) => error?.code === 11000 && Object.keys(error.keyPattern)[0] === field;

describe('User.getProfileStatus (REQ-014)', () => {
  test('staff accounts are always complete', () => {
    expect(User.getProfileStatus({ roleName: 'ADMIN' })).toEqual({ profileCompleted: true, missingFields: [] });
    expect(User.getProfileStatus({ roleName: 'SALES_STAFF' })).toEqual({ profileCompleted: true, missingFields: [] });
  });

  test('a customer lists every missing field', () => {
    expect(User.getProfileStatus({ roleName: 'CUSTOMER' }))
      .toEqual({ profileCompleted: false, missingFields: ['fullName', 'phone', 'password'] });
    expect(User.getProfileStatus({ roleName: 'CUSTOMER', fullName: 'An', phone: '0901234567', password: 'h' }))
      .toEqual({ profileCompleted: true, missingFields: [] });
  });
});

describe('conditional required fields (INV-2, S13)', () => {
  test('a Google customer may be saved without password and full name', async () => {
    const { id } = await h.createUser({ roleName: 'CUSTOMER', password: null, fullName: undefined, firebaseUid: 'g-1' });
    const doc = await User.findById(id).select('+password');
    expect(doc.profileStatus()).toEqual({ profileCompleted: false, missingFields: ['fullName', 'phone', 'password'] });
  });

  test('a customer without Google identity must have a password', async () => {
    await expect(h.createUser({ roleName: 'CUSTOMER', password: null, phone: '0901234567' }))
      .rejects.toThrow(/Password is required/);
  });

  test('staff must have a password and a full name', async () => {
    await expect(h.createUser({ roleName: 'SALES_STAFF', password: null })).rejects.toThrow(/Password is required/);
    await expect(h.createUser({ roleName: 'SALES_STAFF', fullName: undefined })).rejects.toThrow(/Full name is required/);
  });
});

describe('unique constraints (INV-1, REQ-021)', () => {
  test('two customers cannot share a phone number', async () => {
    await h.createUser({ roleName: 'CUSTOMER', phone: '0901234567' });
    const error = await h.createUser({ roleName: 'CUSTOMER', phone: '0901234567' }).catch((e) => e);
    expect(isDuplicate(error, 'phone')).toBe(true);
  });

  test('staff phone numbers are not constrained', async () => {
    await h.createUser({ roleName: 'SALES_STAFF', phone: '0901234567' });
    await expect(h.createUser({ roleName: 'SALES_STAFF', phone: '0901234567' })).resolves.toBeDefined();
  });

  test('a Google identity and a Customer can each be linked to one account only', async () => {
    const customer = new mongoose.Types.ObjectId();
    await h.createUser({ roleName: 'CUSTOMER', firebaseUid: 'g-1', password: null, customer });

    const uidClash = await h.createUser({ roleName: 'CUSTOMER', firebaseUid: 'g-1', password: null }).catch((e) => e);
    const customerClash = await h.createUser({ roleName: 'CUSTOMER', customer }).catch((e) => e);

    expect(isDuplicate(uidClash, 'firebaseUid')).toBe(true);
    expect(isDuplicate(customerClash, 'customer')).toBe(true);
  });

  test('emails stay unique across every account type', async () => {
    await h.createUser({ email: 'same@trustcar.vn' });
    const error = await h.createUser({ roleName: 'CUSTOMER', email: 'same@trustcar.vn' }).catch((e) => e);
    expect(isDuplicate(error, 'email')).toBe(true);
  });
});

describe('toSafeObject (REQ-015, NFR-06)', () => {
  test('includes profile status and hides secrets and the Firebase UID', async () => {
    const { id } = await h.createUser({ roleName: 'CUSTOMER', password: null, firebaseUid: 'g-9', fullName: 'An' });
    const doc = await User.findById(id).select('+password +firebaseUid +tokenVersion');
    const safe = doc.toSafeObject();

    expect(safe).toMatchObject({ profileCompleted: false, missingFields: ['phone', 'password'] });
    expect(safe.firebaseUid).toBeUndefined();
    expect(safe.password).toBeUndefined();
    expect(safe.tokenVersion).toBeUndefined();
  });
});
