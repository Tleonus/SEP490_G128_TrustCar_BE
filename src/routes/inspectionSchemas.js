/**
 * @file inspectionSchemas.js
 * @description Joi DTO schemas for the inspection routes. Group, item and
 * minor-defect keys are validated against the central checklist config, so the
 * API accepts exactly what the checklist defines. Server-owned fields
 * (status, verdict, original vehicle info, audit fields) are not part of any
 * schema and are stripped by the validate() middleware.
 */

import Joi from 'joi';
import {
  INSPECTION_LIMITS as L, ItemResult, OVERVIEW_POSITIONS, findGroup, getChecklist,
} from '../config/inspectionChecklist.js';

const photoUrl = Joi.string().trim().uri({ scheme: ['https'] }).max(500);
const note = Joi.string().trim().max(L.NOTE_MAX_LENGTH).allow('');
const vehicleText = Joi.string().trim().max(L.VEHICLE_TEXT_MAX_LENGTH).allow('', null);
const groupKeys = getChecklist().map((group) => group.key);

const vehicleInfoSchema = Joi.object({
  make: vehicleText,
  model: vehicleText,
  variant: vehicleText,
  color: vehicleText,
  year: Joi.number().integer().min(L.MIN_YEAR).max(new Date().getFullYear() + 1).allow(null),
  mileage: Joi.number().integer().min(0).allow(null),
});

const itemSchema = Joi.object({
  itemKey: Joi.string().required(),
  result: Joi.string().valid(...Object.values(ItemResult)).allow(null).default(null),
  note: note.default(''),
  photos: Joi.array().items(photoUrl).max(L.ITEM_PHOTOS_MAX).default([]),
});

const minorDefectSchema = Joi.object({
  type: Joi.string().required(),
  location: Joi.string().trim().max(L.VEHICLE_TEXT_MAX_LENGTH * 2).allow('').default(''),
  description: note.default(''),
  photos: Joi.array().items(photoUrl).max(L.MINOR_DEFECT_PHOTOS_MAX).default([]),
});

/** Cross-field checks a group needs against its checklist definition. */
const checkGroupAgainstChecklist = (group, helpers) => {
  const def = findGroup(group.groupKey);
  const allowedItems = new Set(def.items.map((i) => i.key));
  const seen = new Set();
  for (const item of group.items) {
    if (!allowedItems.has(item.itemKey)) return helpers.message(`${item.itemKey} is not an item of ${def.key}`);
    if (seen.has(item.itemKey)) return helpers.message(`${item.itemKey} appears more than once`);
    seen.add(item.itemKey);
  }
  const allowedDefects = new Set(def.minorDefectTypes.map((t) => t.key));
  const badDefect = group.minorDefects.find((d) => !allowedDefects.has(d.type));
  if (badDefect) return helpers.message(`Minor defect ${badDefect.type} is not allowed in ${def.key}`);
  if (group.odometerPhoto && !def.requiresOdometerPhoto) {
    return helpers.message(`odometerPhoto is only accepted in the odometer group`);
  }
  return group;
};

const groupSchema = Joi.object({
  groupKey: Joi.string().valid(...groupKeys).required(),
  items: Joi.array().items(itemSchema).max(20).default([]),
  note: note.default(''),
  photos: Joi.array().items(photoUrl).max(L.GROUP_PHOTOS_MAX).default([]),
  odometerPhoto: photoUrl.allow(null).default(null),
  minorDefects: Joi.array().items(minorDefectSchema).max(L.MINOR_DEFECTS_MAX).default([]),
}).custom(checkGroupAgainstChecklist);

/** PATCH /inspections/:id — save part of a draft. */
export const updateDraftSchema = Joi.object({
  vehicleInfo: Joi.object({ confirmed: vehicleInfoSchema.required() }),
  overviewPhotos: Joi.object(Object.fromEntries(OVERVIEW_POSITIONS.map((pos) => [pos, photoUrl.allow(null)]))),
  groups: Joi.array().items(groupSchema).max(groupKeys.length).unique('groupKey'),
}).min(1);

const strictBool = Joi.boolean().strict().required();

/** POST /inspections/cars/:id/inspect — admin quick inspection with the 5 KAN-14 booleans. */
export const quickInspectSchema = Joi.object({
  criteria: Joi.object({
    noMajorAccident: strictBool,
    noWaterDamage: strictBool,
    engineGearboxIntact: strictBool,
    verifiedOdo: strictBool,
    electricalSystemPassed: strictBool,
  }).required(),
  odo: Joi.number().integer().min(0).required(),
  notes: note.default(''),
  // Folder of the car is checked in the service (the schema does not know :id).
  evidenceImages: Joi.array().items(photoUrl).max(20).default([]),
});

export default { updateDraftSchema, quickInspectSchema };
