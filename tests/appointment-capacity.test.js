/**
 * @file appointment-capacity.test.js
 * @description Slot capacity comes from `testDrive.maxGuestsPerSlot` and falls back to the default.
 *
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-201
 */

import { capacityFrom, getSlotCapacity } from '../src/services/appointmentCapacity.js';
import { DEFAULT_SLOT_CAPACITY } from '../src/constants/appointmentRules.js';

const withGuests = (maxGuestsPerSlot) => ({ testDrive: { maxGuestsPerSlot } });

describe('capacityFrom', () => {
  test('uses the configured number', () => {
    expect(capacityFrom(withGuests(2))).toBe(2);
    expect(capacityFrom(withGuests(100))).toBe(100);
  });

  test.each([[0], [-1], [2.5], ['3'], [null], [undefined], [Number.NaN]])('falls back to the default for %p', (value) => {
    expect(capacityFrom(withGuests(value))).toBe(DEFAULT_SLOT_CAPACITY);
  });

  test('falls back to the default when the section is missing', () => {
    expect(capacityFrom({})).toBe(DEFAULT_SLOT_CAPACITY);
    expect(capacityFrom(null)).toBe(DEFAULT_SLOT_CAPACITY);
  });
});

describe('getSlotCapacity', () => {
  test('reads the settings on every call (no cache), so an Admin change applies at once', async () => {
    let stored = 3;
    const load = async () => withGuests(stored);
    expect(await getSlotCapacity({ load })).toBe(3);
    stored = 2;
    expect(await getSlotCapacity({ load })).toBe(2);
  });
});
