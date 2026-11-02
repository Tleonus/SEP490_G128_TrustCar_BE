/**
 * @file inspection-rules.test.js
 * @description Unit tests for the CPO inspection checklist configuration and the
 * pure inspection rules (no database, no HTTP).
 */

import mongoose from 'mongoose';
import InspectionRecord, { withLifecycleDefaults } from '../src/models/InspectionRecord.js';
import {
  CHECKLIST_VERSION,
  OVERVIEW_POSITIONS,
  getChecklist,
  findGroup,
} from '../src/config/inspectionChecklist.js';

const KAN14_CRITERIA = [
  'noMajorAccident',
  'noWaterDamage',
  'engineGearboxIntact',
  'verifiedOdo',
  'electricalSystemPassed',
];

describe('inspection checklist configuration', () => {
  const checklist = getChecklist(CHECKLIST_VERSION);

  test('version 1.0 has 5 groups and 24 items', () => {
    expect(CHECKLIST_VERSION).toBe('1.0');
    expect(checklist).toHaveLength(5);
    expect(checklist.flatMap((group) => group.items)).toHaveLength(24);
  });

  test('each group maps to exactly one distinct KAN-14 criterion', () => {
    expect(checklist.map((group) => group.criteriaKey).sort()).toEqual([...KAN14_CRITERIA].sort());
  });

  test('flood and odometer groups accept no minor defects; the others do', () => {
    expect(findGroup('G2_FLOOD').minorDefectTypes).toHaveLength(0);
    expect(findGroup('G4_ODOMETER').minorDefectTypes).toHaveLength(0);
    ['G1_BODY_FRAME', 'G3_ENGINE_GEARBOX', 'G5_ELECTRICAL_SAFETY'].forEach((key) => {
      expect(findGroup(key).minorDefectTypes.length).toBeGreaterThan(0);
    });
  });

  test('only the odometer group requires an odometer photo', () => {
    expect(checklist.filter((group) => group.requiresOdometerPhoto).map((g) => g.key))
      .toEqual(['G4_ODOMETER']);
  });

  test('item keys are unique within the checklist', () => {
    const keys = checklist.flatMap((group) => group.items.map((i) => i.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('has 4 overview positions and returns null for an unknown version', () => {
    expect(OVERVIEW_POSITIONS).toEqual(['FRONT', 'REAR', 'LEFT', 'RIGHT']);
    expect(getChecklist('9.9')).toBeNull();
    expect(findGroup('NOPE')).toBeNull();
  });
});

describe('InspectionRecord schema', () => {
  const id = () => new mongoose.Types.ObjectId();
  const allTrue = Object.fromEntries(KAN14_CRITERIA.map((key) => [key, true]));

  test('a draft without verdict fields is valid', () => {
    const draft = new InspectionRecord({
      carId: id(),
      status: 'DRAFT',
      source: 'STAFF',
      checklistVersion: '1.0',
      createdBy: id(),
      vehicleInfo: { original: { make: 'Toyota', mileage: 1000 }, confirmed: { make: 'Toyota' } },
      groups: [{ groupKey: 'G1_BODY_FRAME', items: [{ itemKey: 'PILLARS', result: null }] }],
    });

    expect(draft.validateSync()).toBeUndefined();
  });

  test.each(['criteria', 'odo', 'result', 'inspectorId'])(
    'a SUBMITTED record without %s is invalid',
    (field) => {
      const data = {
        carId: id(), inspectorId: id(), status: 'SUBMITTED', source: 'STAFF',
        criteria: allTrue, odo: 1000, result: 'PASSED',
      };
      delete data[field];

      expect(new InspectionRecord(data).validateSync().errors[field]).toBeDefined();
    },
  );

  test('a legacy KAN-14 record (no status/source) stays valid and reads as SUBMITTED/LEGACY', () => {
    const legacy = new InspectionRecord({
      carId: id(), inspectorId: id(), criteria: allTrue, odo: 1000, result: 'PASSED',
    });

    expect(legacy.validateSync()).toBeUndefined();
    expect(legacy.status).toBeUndefined();
    expect(legacy.groups).toBeUndefined();
    expect(withLifecycleDefaults(legacy)).toMatchObject({ status: 'SUBMITTED', source: 'LEGACY' });
    expect(withLifecycleDefaults({ status: 'DRAFT', source: 'STAFF' }))
      .toMatchObject({ status: 'DRAFT', source: 'STAFF' });
  });

  test('rejects unknown item results and lifecycle values', () => {
    const doc = new InspectionRecord({
      carId: id(), status: 'OPEN', source: 'WEB',
      groups: [{ groupKey: 'G1_BODY_FRAME', items: [{ itemKey: 'PILLARS', result: 'MAYBE' }] }],
    });
    const { errors } = doc.validateSync();

    expect(errors.status).toBeDefined();
    expect(errors.source).toBeDefined();
    expect(errors['groups.0.items.0.result']).toBeDefined();
  });

  test('declares a unique partial index allowing one draft per car', () => {
    const draftIndex = InspectionRecord.schema.indexes()
      .find(([, options]) => options.name === 'uniq_draft_per_car');

    expect(draftIndex).toEqual([
      { carId: 1 },
      expect.objectContaining({ unique: true, partialFilterExpression: { status: 'DRAFT' } }),
    ]);
  });
});

// ── Pure verdict, submit rules and media helpers ───────────────────────────
import { v2 as cloudinary } from 'cloudinary';
import {
  evaluateCPO, generateCpoCertificate, computeGroupResults, deriveCriteria,
} from '../src/services/inspectionVerdict.js';
import { collectSubmitViolations, listRecordImages } from '../src/services/inspectionSubmitRules.js';
import {
  buildUploadSignature, inspectionFolder, isImageInFolder, isInspectionImageUrl, quickInspectionFolder,
} from '../src/services/inspectionMediaService.js';

const CLOUD = 'trustcar-test';
process.env.CLOUDINARY_CLOUD_NAME = CLOUD;
const INSPECTION_ID = '65f000000000000000000001';
const photo = (name, id = INSPECTION_ID) =>
  `https://res.cloudinary.com/${CLOUD}/image/upload/v1700000000/trustcar/inspections/${id}/${name}.jpg`;

/** A record that satisfies every submit rule, with every item PASS. */
const completeRecord = () => ({
  vehicleInfo: {
    confirmed: { make: 'Toyota', model: 'Vios', variant: 'G', color: 'Trắng', year: 2020, mileage: 50000 },
  },
  overviewPhotos: { FRONT: photo('f'), REAR: photo('r'), LEFT: photo('l'), RIGHT: photo('rt') },
  groups: getChecklist().map((groupDef) => ({
    groupKey: groupDef.key,
    items: groupDef.items.map((i) => ({ itemKey: i.key, result: 'PASS', note: '', photos: [] })),
    note: '',
    photos: [photo(`${groupDef.key}-1`)],
    odometerPhoto: groupDef.requiresOdometerPhoto ? photo('odo') : null,
    minorDefects: [],
  })),
});

const violationsOf = (record, carMileage = 50000) => collectSubmitViolations({
  record,
  carMileage,
  checklist: getChecklist(),
  isValidImageUrl: (url) => isInspectionImageUrl(url, INSPECTION_ID),
});

describe('inspection verdict', () => {
  test('evaluateCPO passes only when all 5 criteria are strictly true', () => {
    const all = Object.fromEntries(KAN14_CRITERIA.map((k) => [k, true]));
    expect(evaluateCPO(all)).toBe(true);
    expect(evaluateCPO({ ...all, verifiedOdo: 'true' })).toBe(false);
    expect(evaluateCPO(null)).toBe(false);
  });

  test('generateCpoCertificate matches CPO-YYYYMMDD-XXXX', () => {
    expect(generateCpoCertificate()).toMatch(/^CPO-\d{8}-[0-9A-F]{4}$/);
  });

  test('all items PASS → every group passes and all 5 criteria are true', () => {
    const results = computeGroupResults(completeRecord().groups, getChecklist());
    expect(Object.values(results).every(Boolean)).toBe(true);
    expect(evaluateCPO(deriveCriteria(results, getChecklist()))).toBe(true);
  });

  test('a NOT_CHECKABLE item fails its group and only its criterion', () => {
    const record = completeRecord();
    record.groups[2].items[0] = { itemKey: 'ENGINE_START_NOISE', result: 'NOT_CHECKABLE', note: 'Hết ắc quy', photos: [] };
    const criteria = deriveCriteria(computeGroupResults(record.groups, getChecklist()), getChecklist());

    expect(criteria.engineGearboxIntact).toBe(false);
    expect(criteria.noMajorAccident).toBe(true);
    expect(evaluateCPO(criteria)).toBe(false);
  });

  test('a missing item fails the group; minor defects do not', () => {
    const record = completeRecord();
    record.groups[0].items.pop();
    record.groups[4].minorDefects = [{ type: 'BUTTON_WEAR', location: 'Vô lăng', description: 'Mòn', photos: [photo('d')] }];
    const results = computeGroupResults(record.groups, getChecklist());

    expect(results.G1_BODY_FRAME).toBe(false);
    expect(results.G5_ELECTRICAL_SAFETY).toBe(true);
  });
});

describe('submit rules', () => {
  test('a complete record has no violations', () => {
    expect(violationsOf(completeRecord())).toEqual([]);
  });

  test('reports every violation at once with field paths', () => {
    const record = completeRecord();
    record.overviewPhotos.REAR = null;
    record.groups[3].odometerPhoto = null;
    record.groups[0].items[1] = { itemKey: 'PILLARS', result: 'FAIL', note: '', photos: [] };
    const fields = violationsOf(record).map((v) => `${v.field}:${v.code}`);

    expect(fields).toEqual(expect.arrayContaining([
      'overviewPhotos.REAR:REQUIRED',
      'groups.3.odometerPhoto:ODOMETER_PHOTO_REQUIRED',
      'groups.0.items.1.note:FAIL_NOTE_REQUIRED',
      'groups.0.items.1.photos:FAIL_PHOTO_REQUIRED',
    ]));
  });

  test('unevaluated items, missing groups and missing vehicle fields are reported', () => {
    const record = completeRecord();
    record.groups[1].items[0].result = null;
    record.groups.splice(4, 1);
    record.vehicleInfo.confirmed.variant = '';
    const codes = violationsOf(record).map((v) => `${v.field}:${v.code}`);

    expect(codes).toEqual(expect.arrayContaining([
      'groups.1.items.0.result:ITEM_NOT_EVALUATED',
      'groups.G5_ELECTRICAL_SAFETY:GROUP_MISSING',
      'vehicleInfo.confirmed.variant:REQUIRED',
    ]));
  });

  test('NOT_CHECKABLE needs a reason; a group needs at least one photo', () => {
    const record = completeRecord();
    record.groups[1].items[0] = { itemKey: 'CARPET_FLOOR', result: 'NOT_CHECKABLE', note: ' ', photos: [] };
    record.groups[1].photos = [];
    const codes = violationsOf(record).map((v) => v.code);

    expect(codes).toEqual(expect.arrayContaining(['REASON_REQUIRED', 'GROUP_PHOTO_REQUIRED']));
  });

  test('minor defects: wrong type or group 2/4 rejected, incomplete defect reported', () => {
    const record = completeRecord();
    record.groups[1].minorDefects = [{ type: 'PAINT_SCRATCH_LIGHT', location: 'x', description: 'y', photos: [photo('a')] }];
    record.groups[0].minorDefects = [{ type: 'PAINT_SCRATCH_LIGHT', location: '', description: '', photos: [] }];
    const codes = violationsOf(record).map((v) => `${v.field}:${v.code}`);

    expect(codes).toEqual(expect.arrayContaining([
      'groups.1.minorDefects.0.type:MINOR_DEFECT_NOT_ALLOWED',
      'groups.0.minorDefects.0.location:REQUIRED',
      'groups.0.minorDefects.0.description:REQUIRED',
      'groups.0.minorDefects.0.photos:REQUIRED',
    ]));
  });

  test('mileage lower than the car is MILEAGE_DECREASE; equal or higher is fine', () => {
    expect(violationsOf(completeRecord(), 60000).map((v) => v.code)).toEqual(['MILEAGE_DECREASE']);
    expect(violationsOf(completeRecord(), 50000)).toEqual([]);
  });

  test('photos outside this inspection folder are INVALID_IMAGE_URL', () => {
    const record = completeRecord();
    record.groups[0].photos = [photo('x', '65f000000000000000000009')];
    record.overviewPhotos.FRONT = 'https://evil.example.com/a.jpg';

    expect(violationsOf(record).filter((v) => v.code === 'INVALID_IMAGE_URL').map((v) => v.field))
      .toEqual(['overviewPhotos.FRONT', 'groups.0.photos.0']);
  });

  test('listRecordImages collects overview, group, item, odometer and defect photos', () => {
    const record = completeRecord();
    record.groups[0].items[0].photos = [photo('i')];
    record.groups[0].minorDefects = [{ type: 'DENT_MINOR', location: 'a', description: 'b', photos: [photo('d')] }];

    expect(listRecordImages(record)).toHaveLength(4 + 5 + 1 + 1 + 1);
  });
});

describe('inspection media', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.CLOUDINARY_CLOUD_NAME = CLOUD;
    process.env.CLOUDINARY_API_KEY = 'key-123';
    process.env.CLOUDINARY_API_SECRET = 'secret-xyz';
  });
  afterAll(() => { process.env = saved; });

  test('signature is bound to the inspection folder and verifiable; secret not returned', () => {
    const payload = buildUploadSignature(inspectionFolder(INSPECTION_ID), 1_700_000_000_000);

    expect(payload).toMatchObject({
      cloudName: CLOUD, apiKey: 'key-123', timestamp: 1_700_000_000,
      folder: `trustcar/inspections/${INSPECTION_ID}`, allowedFormats: 'jpg,png,webp',
    });
    expect(payload.signature).toBe(cloudinary.utils.api_sign_request(
      { timestamp: 1_700_000_000, folder: payload.folder, allowed_formats: 'jpg,png,webp' }, 'secret-xyz'));
    expect(JSON.stringify(payload)).not.toContain('secret-xyz');
  });

  test('missing Cloudinary configuration → 503 UPLOAD_NOT_CONFIGURED', () => {
    delete process.env.CLOUDINARY_API_SECRET;
    expect(() => buildUploadSignature(inspectionFolder(INSPECTION_ID))).toThrow(expect.objectContaining({ statusCode: 503 }));
  });

  test.each([
    [photo('a'), true],
    [`https://res.cloudinary.com/${CLOUD}/image/upload/trustcar/inspections/${INSPECTION_ID}/a.png`, true],
    [`http://res.cloudinary.com/${CLOUD}/image/upload/trustcar/inspections/${INSPECTION_ID}/a.png`, false],
    [`https://res.cloudinary.com/other/image/upload/trustcar/inspections/${INSPECTION_ID}/a.png`, false],
    [`https://res.cloudinary.com/${CLOUD}/image/upload/trustcar/inspections/${INSPECTION_ID}/../x/a.png`, false],
    [`https://res.cloudinary.com/${CLOUD}/image/upload/trustcar/inspections/${INSPECTION_ID}/`, false],
    [`https://res.cloudinary.com/${CLOUD}.evil.com/image/upload/trustcar/inspections/${INSPECTION_ID}/a.png`, false],
    [42, false],
    // transformations / nested folders would let stored evidence show something else
    [`https://res.cloudinary.com/${CLOUD}/image/upload/l_fetch:aHR0cHM6Ly9ldmlsLmNvbS94LmpwZw==/trustcar/inspections/${INSPECTION_ID}/a.jpg`, false],
    [`https://res.cloudinary.com/${CLOUD}/image/upload/l_text:Arial_80:PASS/v1/trustcar/inspections/${INSPECTION_ID}/a.jpg`, false],
    [`https://res.cloudinary.com/${CLOUD}/image/upload/w_100/trustcar/inspections/${INSPECTION_ID}/a.jpg`, false],
    [`https://res.cloudinary.com/${CLOUD}/image/upload/other/trustcar/inspections/${INSPECTION_ID}/a.jpg`, false],
    [`https://res.cloudinary.com/${CLOUD}/image/upload/v1/trustcar/inspections/${INSPECTION_ID}/sub/a.jpg`, false],
    [`https://res.cloudinary.com/${CLOUD}/image/upload/v1/trustcar/inspections/${INSPECTION_ID}/a.jpg?x=1`, false],
  ])('isInspectionImageUrl(%s) → %s', (url, expected) => {
    expect(isInspectionImageUrl(url, INSPECTION_ID)).toBe(expected);
  });

  test('quick-inspection folder is per car and distinct from checklist folders', () => {
    const carId = '65f0000000000000000000aa';
    const folder = quickInspectionFolder(carId);

    expect(folder).toBe(`trustcar/inspections/quick/${carId}`);
    expect(isImageInFolder(`https://res.cloudinary.com/${CLOUD}/image/upload/v9/${folder}/a.jpg`, folder)).toBe(true);
    expect(isImageInFolder(`https://res.cloudinary.com/${CLOUD}/image/upload/v9/${folder}/a.jpg`,
      quickInspectionFolder('65f0000000000000000000bb'))).toBe(false);
    expect(isImageInFolder(`https://res.cloudinary.com/${CLOUD}/image/upload/v1/trustcar/cars/a.jpg`, folder)).toBe(false);
  });
});
