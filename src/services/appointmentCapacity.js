/**
 * @file appointmentCapacity.js
 * @description How many visits (different customers) one fixed slot can hold.
 *
 *   ceiling   the Admin setting `testDrive.maxGuestsPerSlot` ("số khách tối đa mỗi khung"),
 *             read on every request (`getBaseSettings` has no cache)
 *   staff     one visit needs one sales staff member at work that day (appointmentStaffing.js),
 *             so a slot holds min(ceiling, staff at work that day) visits
 *
 * Lowering the capacity never touches existing visits (REQ-203): it only stops new bookings
 * until the slot has fewer visits than the new capacity.
 *
 * Ref: .sdd/features/test-drive-capacity-guard/SPEC.md (REQ-201, REQ-203)
 */

import { DEFAULT_SLOT_CAPACITY } from '../constants/appointmentRules.js';
import { getBaseSettings } from './baseSettingsService.js';
import { vnDateKey } from './appointmentSlotRules.js';
import { capacityOn, loadStaffing } from './appointmentStaffing.js';

/** Pure: the capacity stored in a settings object, or the default when it is not a positive integer. */
export const capacityFrom = (settings) => {
  const value = settings?.testDrive?.maxGuestsPerSlot;
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_SLOT_CAPACITY;
};

/**
 * The Admin ceiling alone (no staff).
 * @param {{ load?: () => Promise<object> }} [options]  `load` replaces the settings read (tests).
 * @returns {Promise<number>}
 */
export const getSlotCapacity = async ({ load = getBaseSettings } = {}) => capacityFrom(await load());

/**
 * Capacity of the slots of several Vietnam days.
 * @param {string[]} dateKeys
 * @returns {Promise<{ staffing: object|null, ceiling: number, capacityOn: (dateKey: string) => number }>}
 */
export const getDayCapacities = async (dateKeys) => {
  const [ceiling, staffing] = await Promise.all([getSlotCapacity(), loadStaffing(dateKeys)]);
  return { staffing, ceiling, capacityOn: (dateKey) => capacityOn(staffing, dateKey, ceiling) };
};

/**
 * Capacity of the slot at `scheduledAt`, with the staffing of its day.
 * @returns {Promise<{ capacity: number, staffing: object|null }>}
 */
export const getCapacityAt = async (scheduledAt) => {
  const dateKey = vnDateKey(scheduledAt);
  const day = await getDayCapacities([dateKey]);
  return { capacity: day.capacityOn(dateKey), staffing: day.staffing };
};

export default { capacityFrom, getSlotCapacity, getDayCapacities, getCapacityAt };
