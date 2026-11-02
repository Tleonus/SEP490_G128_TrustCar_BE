/**
 * @file inspectionSubmitRules.js
 * @description Pure submit-time validation for a digital inspection checklist.
 * Collects EVERY violation (not just the first) so staff can fix the whole
 * form in one pass. Each violation is { field, code, message } where `field`
 * is the path of the offending value inside the record.
 */

import { ItemResult, OVERVIEW_POSITIONS } from '../config/inspectionChecklist.js';

const VEHICLE_FIELDS = ['make', 'model', 'variant', 'color', 'year', 'mileage'];

const isBlank = (value) => value === null || value === undefined || String(value).trim() === '';

/**
 * Lists every image URL stored in a record with its field path.
 * @param {object} record
 * @returns {Array<{ field: string, url: string }>}
 */
export const listRecordImages = (record) => {
  const images = [];
  const push = (field, url) => { if (!isBlank(url)) images.push({ field, url }); };

  OVERVIEW_POSITIONS.forEach((pos) => push(`overviewPhotos.${pos}`, record.overviewPhotos?.[pos]));
  (record.groups || []).forEach((group, g) => {
    const base = `groups.${g}`;
    (group.photos || []).forEach((url, i) => push(`${base}.photos.${i}`, url));
    push(`${base}.odometerPhoto`, group.odometerPhoto);
    (group.items || []).forEach((item, i) =>
      (item.photos || []).forEach((url, p) => push(`${base}.items.${i}.photos.${p}`, url)));
    (group.minorDefects || []).forEach((defect, d) =>
      (defect.photos || []).forEach((url, p) => push(`${base}.minorDefects.${d}.photos.${p}`, url)));
  });
  return images;
};

/** Number of evidence photos attached to a group (group, item and odometer photos). */
const countGroupEvidence = (group) =>
  (group.photos || []).length
  + (group.items || []).reduce((sum, item) => sum + (item.photos || []).length, 0)
  + (isBlank(group.odometerPhoto) ? 0 : 1);

const checkVehicle = (record, carMileage, add) => {
  const confirmed = record.vehicleInfo?.confirmed || {};
  VEHICLE_FIELDS.forEach((key) => {
    if (isBlank(confirmed[key])) add(`vehicleInfo.confirmed.${key}`, 'REQUIRED', `Confirmed ${key} is required.`);
  });
  if (!isBlank(confirmed.mileage) && Number(confirmed.mileage) < Number(carMileage || 0)) {
    add('vehicleInfo.confirmed.mileage', 'MILEAGE_DECREASE',
      `Actual mileage (${confirmed.mileage}) cannot be lower than the recorded mileage (${carMileage}).`);
  }
  OVERVIEW_POSITIONS.forEach((pos) => {
    if (isBlank(record.overviewPhotos?.[pos])) add(`overviewPhotos.${pos}`, 'REQUIRED', `Overview photo ${pos} is required.`);
  });
};

const checkItem = (item, path, add) => {
  if (!item) {
    add(path, 'ITEM_NOT_EVALUATED', 'Item has not been evaluated.');
    return;
  }
  if (!Object.values(ItemResult).includes(item.result)) {
    add(`${path}.result`, 'ITEM_NOT_EVALUATED', 'Item has not been evaluated.');
  } else if (item.result === ItemResult.FAIL) {
    if (isBlank(item.note)) add(`${path}.note`, 'FAIL_NOTE_REQUIRED', 'A failed item needs a technical note.');
    if (!(item.photos || []).length) add(`${path}.photos`, 'FAIL_PHOTO_REQUIRED', 'A failed item needs at least one photo.');
  } else if (item.result === ItemResult.NOT_CHECKABLE && isBlank(item.note)) {
    add(`${path}.note`, 'REASON_REQUIRED', 'An item that could not be checked needs a reason.');
  }
};

const checkMinorDefects = (group, groupDef, base, add) => {
  const allowed = new Set(groupDef.minorDefectTypes.map((t) => t.key));
  (group.minorDefects || []).forEach((defect, d) => {
    const path = `${base}.minorDefects.${d}`;
    if (!allowed.has(defect.type)) add(`${path}.type`, 'MINOR_DEFECT_NOT_ALLOWED', 'This defect type is not allowed for the group.');
    if (isBlank(defect.location)) add(`${path}.location`, 'REQUIRED', 'Defect location is required.');
    if (isBlank(defect.description)) add(`${path}.description`, 'REQUIRED', 'Defect description is required.');
    if (!(defect.photos || []).length) add(`${path}.photos`, 'REQUIRED', 'A minor defect needs at least one photo.');
  });
};

const checkGroups = (record, checklist, add) => {
  const groups = record.groups || [];
  checklist.forEach((groupDef) => {
    const g = groups.findIndex((group) => group.groupKey === groupDef.key);
    if (g === -1) {
      add(`groups.${groupDef.key}`, 'GROUP_MISSING', `Group ${groupDef.key} has not been evaluated.`);
      return;
    }
    const group = groups[g];
    const base = `groups.${g}`;
    groupDef.items.forEach((itemDef) => {
      const i = (group.items || []).findIndex((item) => item.itemKey === itemDef.key);
      checkItem(i === -1 ? null : group.items[i], i === -1 ? `${base}.items.${itemDef.key}` : `${base}.items.${i}`, add);
    });
    if (groupDef.requiresOdometerPhoto && isBlank(group.odometerPhoto)) {
      add(`${base}.odometerPhoto`, 'ODOMETER_PHOTO_REQUIRED', 'A photo of the odometer is required.');
    }
    if (countGroupEvidence(group) === 0) add(`${base}.photos`, 'GROUP_PHOTO_REQUIRED', 'Each group needs at least one evidence photo.');
    checkMinorDefects(group, groupDef, base, add);
  });
};

/**
 * Returns every rule a record breaks before it may be submitted.
 *
 * @param {object} params
 * @param {object} params.record - inspection record (plain object)
 * @param {number} params.carMileage - mileage currently stored on the car
 * @param {ReadonlyArray<object>} params.checklist - checklist groups of the record's version
 * @param {(url: string) => boolean} params.isValidImageUrl - accepts only this inspection's photos
 * @returns {Array<{ field: string, code: string, message: string }>} empty when submittable
 */
export const collectSubmitViolations = ({ record, carMileage, checklist, isValidImageUrl }) => {
  const violations = [];
  const add = (field, code, message) => violations.push({ field, code, message });

  checkVehicle(record, carMileage, add);
  checkGroups(record, checklist, add);
  listRecordImages(record).forEach(({ field, url }) => {
    if (!isValidImageUrl(url)) add(field, 'INVALID_IMAGE_URL', 'Image must be uploaded to this inspection\'s folder.');
  });
  return violations;
};

export default { collectSubmitViolations, listRecordImages };
