/**
 * @file profile-schema.test.js
 * @description The Joi schemas of the profile API, run through the same strict middleware the
 * routes use: what is accepted, what is normalised, and what is refused with 422.
 *
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-005
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-013
 */

import { validateBodyStrict } from '../src/routes/appointmentSchemas.js';
import { updateProfileSchema, updateSettingsSchema, STREET_MAX, ADDRESS_PART_MAX } from '../src/routes/profileSchemas.js';
import { todayInVietnam } from '../src/services/profileRules.js';

/** Runs a body through the strict middleware; returns `{ error, body }` (error = the 422 answer, or null). */
const run = (schema, body) => {
  const req = { body: structuredClone(body) };
  const res = { status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
  let passed = false;
  validateBodyStrict(schema)(req, res, () => { passed = true; });
  const error = passed ? null : { statusCode: res.statusCode, code: res.payload?.code, errors: res.payload?.errors };
  return { error, body: req.body };
};
const profile = (body) => run(updateProfileSchema, body);
const settings = (body) => run(updateSettingsSchema, body);
const fields = (result) => (result.error?.errors ?? []).map((e) => e.field);

describe('updateProfileSchema: accepted', () => {
  it.each([
    [{ fullName: 'Nguyễn Văn A' }],
    [{ phone: '0901234567' }],
    [{ address: { city: 'Hà Nội' } }],
    [{ address: { street: '', district: null } }],
    [{ dateOfBirth: '2000-05-20' }],
    [{ dateOfBirth: null }],
    [{ gender: 'FEMALE' }],
    [{ gender: null }],
    [{ fullName: 'An Bình', phone: '0907654321', address: { street: '1 Lê Lợi', province: 'Thừa Thiên Huế' }, dateOfBirth: '1999-12-31', gender: 'OTHER' }],
  ])('%j', (body) => {
    expect(profile(body).error).toBeNull();
  });

  it('trims the name and normalises +84 phones to 0…', () => {
    const { body } = profile({ fullName: '  Nguyễn Văn A ', phone: '+84901234567' });
    expect(body).toEqual({ fullName: 'Nguyễn Văn A', phone: '0901234567' });
  });

  it('trims address parts', () => {
    expect(profile({ address: { city: '  Hà Nội ' } }).body.address.city).toBe('Hà Nội');
  });

  it('accepts a date of birth of today (Vietnam) and of 1900-01-01', () => {
    expect(profile({ dateOfBirth: todayInVietnam() }).error).toBeNull();
    expect(profile({ dateOfBirth: '1900-01-01' }).error).toBeNull();
  });

  it('accepts the maximum lengths', () => {
    expect(profile({ address: { street: 'a'.repeat(STREET_MAX), city: 'b'.repeat(ADDRESS_PART_MAX) } }).error).toBeNull();
    expect(profile({ fullName: 'x'.repeat(100) }).error).toBeNull();
  });
});

describe('updateProfileSchema: refused with 422 (AC-12, 14, 16)', () => {
  it('an empty body, or an empty address object', () => {
    expect(profile({}).error).toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
    expect(profile({ address: {} }).error).toMatchObject({ statusCode: 422 });
  });

  it.each(['email', 'role', 'password', 'avatar', 'isActive', 'customer', 'tokenVersion', 'whatever'])('the unknown/forbidden field "%s"', (field) => {
    const result = profile({ fullName: 'An', [field]: 'x' });
    expect(result.error).toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
    expect(fields(result)).toContain(field);
  });

  it('an unknown address sub-field', () => {
    expect(profile({ address: { country: 'VN' } }).error).toMatchObject({ statusCode: 422 });
  });

  it.each([
    ['fullName', 'A'],
    ['fullName', ''],
    ['fullName', 'x'.repeat(101)],
    ['fullName', 5],
    ['phone', ''],
    ['phone', null],
    ['phone', '123'],
    ['phone', 'abc'],
    ['phone', '+1555123456'],
  ])('%s = %j', (field, value) => {
    expect(profile({ [field]: value }).error).toMatchObject({ statusCode: 422 });
  });

  it('address parts above their limit', () => {
    expect(profile({ address: { street: 'a'.repeat(STREET_MAX + 1) } }).error).toMatchObject({ statusCode: 422 });
    expect(profile({ address: { city: 'a'.repeat(ADDRESS_PART_MAX + 1) } }).error).toMatchObject({ statusCode: 422 });
  });

  it.each([
    ['2999-01-01'], ['1800-01-01'], ['1899-12-31'], ['abc'], ['2000-02-31'], ['2000-13-01'], ['20000520'], ['2000-5-20'], [''], [19990101],
  ])('dateOfBirth = %j', (value) => {
    expect(profile({ dateOfBirth: value }).error).toMatchObject({ statusCode: 422 });
  });

  it('a date of birth tomorrow (Vietnam)', () => {
    const tomorrow = new Date(Date.now() + 7 * 3600e3 + 24 * 3600e3).toISOString().slice(0, 10);
    expect(profile({ dateOfBirth: tomorrow }).error).toMatchObject({ statusCode: 422 });
  });

  it.each([['male'], ['M'], ['UNKNOWN'], [''], [1]])('gender = %j', (value) => {
    expect(profile({ gender: value }).error).toMatchObject({ statusCode: 422 });
  });

  it('every problem is reported, not just the first', () => {
    const result = profile({ fullName: 'A', gender: 'X' });
    expect(fields(result).sort()).toEqual(['fullName', 'gender']);
  });
});

describe('updateSettingsSchema', () => {
  it('accepts a boolean marketingConsent', () => {
    expect(settings({ marketingConsent: true }).error).toBeNull();
    expect(settings({ marketingConsent: false }).error).toBeNull();
  });

  it.each([[{}], [{ marketingConsent: 'yes' }], [{ marketingConsent: 'true' }], [{ marketingConsent: 1 }], [{ marketingConsent: null }], [{ marketingConsent: true, extra: 1 }], [{ email: 'a@b.vn' }]])('%j → 422 (AC-20)', (body) => {
    expect(settings(body).error).toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
  });
});
