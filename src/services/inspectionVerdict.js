/**
 * @file inspectionVerdict.js
 * @description Pure CPO verdict logic shared by the digital-checklist submit flow
 * and the admin quick-inspect endpoint, so both always decide the same way.
 */

import crypto from 'crypto';
import dayjs from 'dayjs';
import { ItemResult } from '../config/inspectionChecklist.js';

/**
 * Evaluates 5 Certified Pre-Owned (CPO) criteria.
 * Returns true if ALL 5 criteria are strictly true; false otherwise.
 *
 * @param {object} criteria
 * @param {boolean} criteria.noMajorAccident
 * @param {boolean} criteria.noWaterDamage
 * @param {boolean} criteria.engineGearboxIntact
 * @param {boolean} criteria.verifiedOdo
 * @param {boolean} criteria.electricalSystemPassed
 * @returns {boolean}
 */
export const evaluateCPO = (criteria = {}) => {
  if (!criteria || typeof criteria !== 'object') return false;

  const {
    noMajorAccident,
    noWaterDamage,
    engineGearboxIntact,
    verifiedOdo,
    electricalSystemPassed,
  } = criteria;

  return (
    noMajorAccident === true &&
    noWaterDamage === true &&
    engineGearboxIntact === true &&
    verifiedOdo === true &&
    electricalSystemPassed === true
  );
};

/**
 * Generates a CPO certificate identifier in format: CPO-YYYYMMDD-XXXX
 * where YYYYMMDD is the current date and XXXX is 4 random uppercase hex characters.
 *
 * @returns {string}
 */
export const generateCpoCertificate = () => {
  const dateStr = dayjs().format('YYYYMMDD');
  const randomSuffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `CPO-${dateStr}-${randomSuffix}`;
};

/**
 * Decides pass/fail per group. A group passes only when every item defined by
 * the checklist is present in the record with result PASS; a FAIL, a
 * NOT_CHECKABLE or a missing item fails the group. Minor defects never fail it.
 *
 * @param {Array<object>} groups - record groups ({ groupKey, items[] })
 * @param {ReadonlyArray<object>} checklist - checklist groups of the record's version
 * @returns {Object<string, boolean>} groupKey → passed
 */
export const computeGroupResults = (groups = [], checklist = []) =>
  Object.fromEntries(
    checklist.map((groupDef) => {
      const group = groups.find((g) => g.groupKey === groupDef.key);
      const resultByItem = new Map((group?.items || []).map((i) => [i.itemKey, i.result]));
      const passed = groupDef.items.every((itemDef) => resultByItem.get(itemDef.key) === ItemResult.PASS);
      return [groupDef.key, passed];
    }),
  );

/**
 * Maps group results onto the 5 KAN-14 booleans (one criterion per group).
 *
 * @param {Object<string, boolean>} groupResults - output of computeGroupResults
 * @param {ReadonlyArray<object>} checklist
 * @returns {object} criteria object accepted by evaluateCPO
 */
export const deriveCriteria = (groupResults, checklist = []) =>
  Object.fromEntries(checklist.map((groupDef) => [groupDef.criteriaKey, groupResults[groupDef.key] === true]));

export default {
  evaluateCPO,
  generateCpoCertificate,
  computeGroupResults,
  deriveCriteria,
};
