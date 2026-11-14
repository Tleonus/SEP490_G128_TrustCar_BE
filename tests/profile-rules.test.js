/**
 * @file profile-rules.test.js
 * @description Pure profile rules: editable fields per role, the staff guard, the field-by-field
 * diff (what a PATCH really changes), and how a date of birth is stored and read back.
 *
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-005
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-006
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-011
 */

import {
  editableFieldsFor, assertEditable, isRealDateKey, dobToStored, dobFromStored, todayInVietnam, diffProfile,
} from '../src/services/profileRules.js';

describe('editableFieldsFor', () => {
  it('customers edit contact and extended fields, everyone else only name and phone', () => {
    expect(editableFieldsFor('CUSTOMER')).toEqual(['fullName', 'phone', 'address', 'dateOfBirth', 'gender']);
    for (const role of ['ADMIN', 'SALES_STAFF', 'INSPECTOR', undefined]) expect(editableFieldsFor(role)).toEqual(['fullName', 'phone']);
  });

  it('returns a copy: changing it cannot widen what a role may edit', () => {
    editableFieldsFor('SALES_STAFF').push('gender');
    expect(editableFieldsFor('SALES_STAFF')).toEqual(['fullName', 'phone']);
  });
});

describe('assertEditable (REQ-006)', () => {
  it('lets a customer send any editable field', () => {
    expect(() => assertEditable('CUSTOMER', { fullName: 'A', gender: 'MALE', address: {}, dateOfBirth: null })).not.toThrow();
  });

  it('rejects the customer-only fields from a staff account with 422 naming each one', () => {
    let error;
    try { assertEditable('SALES_STAFF', { fullName: 'Lan', gender: 'MALE', dateOfBirth: '2000-01-01' }); } catch (e) { error = e; }
    expect(error).toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
    expect(error.errors.map((e) => e.field)).toEqual(['gender', 'dateOfBirth']);
  });

  it('accepts a staff PATCH that only has name and phone', () => {
    expect(() => assertEditable('ADMIN', { fullName: 'Lan', phone: '0901234567' })).not.toThrow();
  });
});

describe('date of birth', () => {
  it('a real calendar day only (leap years included)', () => {
    expect(isRealDateKey('2000-02-29')).toBe(true);
    expect(isRealDateKey('1900-02-29')).toBe(false); // 1900 was not a leap year
    for (const bad of ['2000-02-31', '2000-13-01', '2000-00-10', 'abc', '2000-5-20', '', null, undefined, 20000520]) {
      expect(isRealDateKey(bad)).toBe(false);
    }
  });

  it('is stored as 00:00 UTC of that day and read back as the same string', () => {
    const stored = dobToStored('2000-05-20');
    expect(stored.toISOString()).toBe('2000-05-20T00:00:00.000Z');
    expect(dobFromStored(stored)).toBe('2000-05-20');
  });

  it('round-trips at the edges of the year, whatever the server time zone is', () => {
    for (const day of ['1900-01-01', '1999-12-31', '2000-01-01', '2024-02-29']) expect(dobFromStored(dobToStored(day))).toBe(day);
  });

  it('null stays null in both directions', () => {
    expect(dobToStored(null)).toBeNull();
    expect(dobFromStored(null)).toBeNull();
    expect(dobFromStored(undefined)).toBeNull();
  });

  it('today in Vietnam: 23:59 and 00:01 Vietnam time fall on different days', () => {
    expect(todayInVietnam(new Date('2026-11-14T16:59:00Z'))).toBe('2026-11-14'); // 23:59 VN on the 14th
    expect(todayInVietnam(new Date('2026-11-14T17:01:00Z'))).toBe('2026-11-15'); // 00:01 VN on the 15th
    expect(todayInVietnam(new Date('2024-02-28T17:00:00Z'))).toBe('2024-02-29'); // leap day
  });
});

describe('diffProfile', () => {
  const same = {
    user: { fullName: 'Nguyễn An', phone: '0901234567' },
    customer: {
      fullName: 'Nguyễn An', phone: '0901234567',
      address: { street: '1 Lê Lợi', district: null, city: 'Huế', province: null }, dateOfBirth: '2000-05-20', gender: 'MALE',
    },
  };

  it('a patch equal to the stored values changes nothing (C17)', () => {
    const diff = diffProfile(same, { fullName: 'Nguyễn An', phone: '0901234567', address: { city: 'Huế' }, dateOfBirth: '2000-05-20', gender: 'MALE' });
    expect(diff).toEqual({ userFields: {}, customerFields: {}, changed: [] });
  });

  it('a new name goes to both records and is listed once', () => {
    const diff = diffProfile(same, { fullName: 'Nguyễn Văn An' });
    expect(diff).toEqual({ userFields: { fullName: 'Nguyễn Văn An' }, customerFields: { fullName: 'Nguyễn Văn An' }, changed: ['fullName'] });
  });

  it('a new phone goes to both records', () => {
    const diff = diffProfile(same, { phone: '0907654321' });
    expect(diff.userFields).toEqual({ phone: '0907654321' });
    expect(diff.customerFields).toEqual({ phone: '0907654321' });
    expect(diff.changed).toEqual(['phone']);
  });

  it('a Customer that had drifted from the User is repaired when the patch matches the User (REQ-008)', () => {
    const drifted = { ...same, customer: { ...same.customer, phone: '0911111111' } };
    const diff = diffProfile(drifted, { phone: '0901234567' });
    expect(diff.userFields).toEqual({}); // User already right: no write
    expect(diff.customerFields).toEqual({ phone: '0901234567' });
    expect(diff.changed).toEqual(['phone']);
  });

  it('address: only the sub-fields that were sent change, each as its own path (C9)', () => {
    const diff = diffProfile(same, { address: { city: 'Hà Nội' } });
    expect(diff.customerFields).toEqual({ 'address.city': 'Hà Nội' });
    expect(diff.changed).toEqual(['address']);
  });

  it('address: "" and null clear a sub-field; clearing an already empty one changes nothing', () => {
    expect(diffProfile(same, { address: { street: '' } }).customerFields).toEqual({ 'address.street': null });
    expect(diffProfile(same, { address: { district: null } })).toEqual({ userFields: {}, customerFields: {}, changed: [] });
    expect(diffProfile(same, { address: { province: '' } }).changed).toEqual([]);
  });

  it('address: several sub-fields are listed as one changed field', () => {
    const diff = diffProfile(same, { address: { street: 'A', province: 'B' } });
    expect(diff.customerFields).toEqual({ 'address.street': 'A', 'address.province': 'B' });
    expect(diff.changed).toEqual(['address']);
  });

  it('date of birth is stored as 00:00 UTC; null clears it', () => {
    const diff = diffProfile(same, { dateOfBirth: '2001-01-02' });
    expect(diff.customerFields.dateOfBirth.toISOString()).toBe('2001-01-02T00:00:00.000Z');
    expect(diffProfile(same, { dateOfBirth: null }).customerFields).toEqual({ dateOfBirth: null });
  });

  it('gender changes and clears', () => {
    expect(diffProfile(same, { gender: 'FEMALE' }).customerFields).toEqual({ gender: 'FEMALE' });
    expect(diffProfile(same, { gender: null }).customerFields).toEqual({ gender: null });
  });

  it('a customer with no stored extras: sending values sets them', () => {
    const blank = { user: same.user, customer: { ...same.customer, address: undefined, dateOfBirth: null, gender: null } };
    const diff = diffProfile(blank, { address: { city: 'Huế' }, dateOfBirth: '2000-05-20', gender: 'MALE' });
    expect(diff.changed).toEqual(['address', 'dateOfBirth', 'gender']);
  });

  it('a staff account (no Customer) only ever produces User fields', () => {
    const staff = { user: { fullName: 'Lan', phone: '0911000111' }, customer: null };
    const diff = diffProfile(staff, { fullName: 'Lan Sales', phone: '0911000222' });
    expect(diff).toEqual({ userFields: { fullName: 'Lan Sales', phone: '0911000222' }, customerFields: {}, changed: ['fullName', 'phone'] });
  });

  it('fields that were not sent are never touched', () => {
    const diff = diffProfile(same, { gender: 'FEMALE' });
    expect(Object.keys(diff.userFields)).toEqual([]);
    expect(Object.keys(diff.customerFields)).toEqual(['gender']);
  });
});
