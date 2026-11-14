/**
 * @file profile-mapper.test.js
 * @description The profile DTOs are a whitelist: nothing internal can reach the response, even
 * when the stored documents carry it.
 *
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-003
 */

import { toProfileDto, toSettingsDto } from '../src/services/profileMapper.js';

const FORBIDDEN = [
  'password', 'tokenVersion', 'firebaseUid', 'avatar', 'notes', 'source', 'createdBy', 'updatedBy',
  'isActive', 'failedLoginAttempts', 'lockUntil', 'customer', 'refreshToken', 'passwordResetToken',
]; // (`role` is returned on purpose: it is the role NAME; the raw role id must not appear)

const user = (extra = {}) => ({
  _id: 'u1', email: 'an@example.com', roleName: 'CUSTOMER', fullName: 'Nguyễn An', phone: '0901234567',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  // everything below must never appear in the output
  password: '$2a$hash', tokenVersion: 7, firebaseUid: 'g-1', avatar: 'x.png', createdBy: 'a', updatedBy: 'b',
  isActive: true, failedLoginAttempts: 3, lockUntil: new Date(), role: 'roleId', customer: 'c1',
  refreshToken: 'r', passwordResetToken: 't',
  ...extra,
});

const customer = (extra = {}) => ({
  _id: 'c1', fullName: 'Nguyễn An', phone: '0901234567', email: 'an@example.com',
  address: { street: '1 Lê Lợi', district: null, city: 'Huế', province: null },
  dateOfBirth: new Date('2000-05-20T00:00:00Z'), gender: 'MALE', marketingConsent: true,
  notes: 'khách khó tính', source: 'WALK_IN', createdBy: 'a', updatedBy: 'b', isActive: true,
  ...extra,
});

describe('toProfileDto', () => {
  it('a customer gets the contact fields, address, date of birth and gender', () => {
    expect(toProfileDto(user(), customer())).toEqual({
      id: 'u1', email: 'an@example.com', role: 'CUSTOMER', fullName: 'Nguyễn An', phone: '0901234567',
      address: { street: '1 Lê Lợi', district: null, city: 'Huế', province: null },
      dateOfBirth: '2000-05-20', gender: 'MALE',
      editableFields: ['fullName', 'phone', 'address', 'dateOfBirth', 'gender'],
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('never contains a forbidden key, at any depth (AC-03)', () => {
    const json = JSON.stringify(toProfileDto(user(), customer()));
    FORBIDDEN.forEach((key) => expect(json).not.toContain(`"${key}"`));
    expect(json).not.toMatch(/hash|khách khó tính|WALK_IN|g-1|roleId/);
  });

  it('a staff account has null extras and may only edit name and phone (AC-04)', () => {
    const dto = toProfileDto(user({ roleName: 'SALES_STAFF', customer: undefined }), null);
    expect(dto).toMatchObject({ role: 'SALES_STAFF', address: null, dateOfBirth: null, gender: null, editableFields: ['fullName', 'phone'] });
  });

  it('staff never get customer data even if one is passed by mistake', () => {
    const dto = toProfileDto(user({ roleName: 'ADMIN' }), customer());
    expect(dto).toMatchObject({ address: null, dateOfBirth: null, gender: null });
  });

  it('a customer with an empty Customer record gets four null address fields, not null', () => {
    const dto = toProfileDto(user(), customer({ address: undefined, dateOfBirth: null, gender: null }));
    expect(dto.address).toEqual({ street: null, district: null, city: null, province: null });
    expect(dto.dateOfBirth).toBeNull();
    expect(dto.gender).toBeNull();
  });

  it('a customer whose Customer record is missing still gets a well-formed DTO', () => {
    expect(toProfileDto(user(), null).address).toEqual({ street: null, district: null, city: null, province: null });
  });

  it('only the four known address keys pass through', () => {
    const dto = toProfileDto(user(), customer({ address: { street: 'a', city: 'b', secretNote: 'x', geo: [1, 2] } }));
    expect(Object.keys(dto.address)).toEqual(['street', 'district', 'city', 'province']);
  });

  it('missing name and phone are null, not undefined (a stable JSON shape)', () => {
    const dto = toProfileDto(user({ fullName: undefined, phone: undefined }), customer());
    expect(dto.fullName).toBeNull();
    expect(dto.phone).toBeNull();
  });

  it('ids are strings', () => {
    expect(typeof toProfileDto(user({ _id: { toString: () => 'abc' } }), customer()).id).toBe('string');
  });
});

describe('toSettingsDto', () => {
  it('returns exactly { marketingConsent } and nothing else', () => {
    expect(toSettingsDto(customer())).toEqual({ marketingConsent: true });
    expect(Object.keys(toSettingsDto(customer()))).toEqual(['marketingConsent']);
  });

  it('defaults to false when it was never set (AC-18)', () => {
    expect(toSettingsDto(customer({ marketingConsent: undefined }))).toEqual({ marketingConsent: false });
    expect(toSettingsDto(null)).toEqual({ marketingConsent: false });
  });

  it('only a real true counts', () => {
    expect(toSettingsDto(customer({ marketingConsent: 'yes' }))).toEqual({ marketingConsent: false });
  });
});
