/**
 * @file appointmentCapacity.js
 * @description How many visits (different customers) one fixed slot can hold. The number comes
 * from the Admin setting `testDrive.maxGuestsPerSlot` ("số khách tối đa mỗi khung"), because the
 * showroom has a limited number of staff. Read on every request (`getBaseSettings` has no cache),
 * so an Admin change applies to the next booking.
 *
 * Lowering the capacity never touches existing visits (REQ-203): it only stops new bookings
 * until the slot has fewer visits than the new capacity.
 *
 * Ref: .sdd/features/test-drive-capacity-guard/SPEC.md (REQ-201, REQ-203)
 */

import { DEFAULT_SLOT_CAPACITY } from '../constants/appointmentRules.js';
import { getBaseSettings } from './baseSettingsService.js';

/** Pure: the capacity stored in a settings object, or the default when it is not a positive integer. */
export const capacityFrom = (settings) => {
  const value = settings?.testDrive?.maxGuestsPerSlot;
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_SLOT_CAPACITY;
};

/**
 * @param {{ load?: () => Promise<object> }} [options]  `load` replaces the settings read (tests).
 * @returns {Promise<number>}
 */
export const getSlotCapacity = async ({ load = getBaseSettings } = {}) => capacityFrom(await load());

export default { capacityFrom, getSlotCapacity };
