/**
 * @file appointment-cancel-reason.test.js
 * @description The single text column `cancellationReason` carries a customer's words,
 * a staff choice (`<CODE>|<note>`) or a system marker. These pure helpers keep them apart.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-020, REQ-030, C20–C22; AC-29)
 */

import {
  encodeStaffReason, parseStaffReason, labelOf, isReasonCode, isSystemMarker, isForbiddenForUser,
} from '../src/services/appointmentCancelReason.js';
import { normalizeReason, normalizeStaffCancel } from '../src/services/appointmentInput.js';
import { CANCEL_REASON_LABELS } from '../src/constants/appointmentRules.js';

describe('encode / parse of a staff reason', () => {
  it('round-trips code and note; the note may be empty or contain "|"', () => {
    expect(parseStaffReason(encodeStaffReason('SHOWROOM_BUSY', 'a|b'))).toEqual({
      code: 'SHOWROOM_BUSY', label: CANCEL_REASON_LABELS.SHOWROOM_BUSY, note: 'a|b',
    });
    expect(parseStaffReason(encodeStaffReason('OTHER', ''))).toMatchObject({ code: 'OTHER', note: null });
    expect(parseStaffReason(encodeStaffReason('OTHER', undefined))).toMatchObject({ note: null });
  });

  it.each([null, undefined, 42, '', 'bận', 'NOPE|x', 'other|x', ' OTHER|x', 'OTHER x'])('%j is not a staff value', (value) => {
    expect(parseStaffReason(value)).toBeNull();
  });

  it('knows the four codes and their customer-facing labels', () => {
    ['CUSTOMER_WILL_NOT_COME', 'SHOWROOM_BUSY', 'CUSTOMER_CHANGED_MIND', 'OTHER'].forEach((code) => {
      expect(isReasonCode(code)).toBe(true);
      expect(typeof labelOf(code)).toBe('string');
    });
    expect(isReasonCode('x')).toBe(false);
    expect(labelOf('x')).toBeNull();
  });
});

describe('what a customer may not store (C22)', () => {
  it.each([
    'AUTO_CAR_UNAVAILABLE:SOLD', 'RESCHEDULED:APT-0007', 'RACE_LOST', 'BOOKING_ABORTED',
    'SHOWROOM_BUSY|x', 'OTHER|', 'CUSTOMER_WILL_NOT_COME|gọi',
  ])('%s is forbidden', (text) => {
    expect(isForbiddenForUser(text)).toBe(true);
    expect(() => normalizeReason(text)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('ordinary text, even mentioning a marker word, is fine', () => {
    ['bận việc', 'tôi RACE_LOST', 'OTHER', 'x | y'].forEach((text) => {
      expect(isForbiddenForUser(text)).toBe(false);
      expect(normalizeReason(text)).toBe(text);
    });
    expect(isSystemMarker('RACE_LOST')).toBe(true);
  });
});

describe('normalizeStaffCancel', () => {
  it('stores `<CODE>|<trimmed note>`', () => {
    expect(normalizeStaffCancel({ reasonCode: 'CUSTOMER_WILL_NOT_COME', reason: '  gọi lúc 9:45 ' }))
      .toBe('CUSTOMER_WILL_NOT_COME|gọi lúc 9:45');
    expect(normalizeStaffCancel({ reasonCode: 'SHOWROOM_BUSY' })).toBe('SHOWROOM_BUSY|');
  });

  it('without a code it is OTHER and a note is mandatory (Spec 1.0.0 clients)', () => {
    expect(normalizeStaffCancel({ reason: 'hết xe' })).toBe('OTHER|hết xe');
    expect(() => normalizeStaffCancel({})).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => normalizeStaffCancel({ reasonCode: 'OTHER', reason: '  ' })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('rejects an unknown code and a note over 300 characters', () => {
    expect(() => normalizeStaffCancel({ reasonCode: 'NOPE', reason: 'x' })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => normalizeStaffCancel({ reasonCode: 'SHOWROOM_BUSY', reason: 'x'.repeat(301) })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(normalizeStaffCancel({ reasonCode: 'SHOWROOM_BUSY', reason: 'x'.repeat(300) })).toHaveLength('SHOWROOM_BUSY|'.length + 300);
  });
});
