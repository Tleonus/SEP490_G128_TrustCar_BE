/**
 * @file inspection-report-mapper.test.js
 * @description Unit tests for the public CPO inspection report builder (pure, no DB):
 * FULL / MINIMAL levels, allow-listed fields, initials and public image filtering.
 */

import { getChecklist, PUBLIC_REPORT_SCOPE_NOTE } from '../src/config/inspectionChecklist.js';
import { buildPublicReport, toInitials } from '../src/services/inspectionReportMapper.js';
import { isPublicImageUrl } from '../src/services/inspectionMediaService.js';

const CLOUD = 'trustcar-test';
process.env.CLOUDINARY_CLOUD_NAME = CLOUD;
const RID = '65f000000000000000000001';
const img = (name, folder = `trustcar/inspections/${RID}`) =>
  `https://res.cloudinary.com/${CLOUD}/image/upload/v1700000000/${folder}/${name}.jpg`;
const allTrue = {
  noMajorAccident: true, noWaterDamage: true, engineGearboxIntact: true, verifiedOdo: true, electricalSystemPassed: true,
};

const car = {
  _id: 'c1', make: 'TOYOTA', model: 'Vios', variant: '1.5G', year: 2020, mileage: 40000,
  specifications: { color: 'Trắng' }, sellerPhone: '0900000000',
};

const fullRecord = () => ({
  _id: RID,
  source: 'STAFF',
  status: 'SUBMITTED',
  result: 'PASSED',
  checklistVersion: '1.0',
  cpoCertificateId: 'CPO-20261102-3F9A',
  submittedAt: new Date('2026-11-02T08:15:00Z'),
  createdAt: new Date('2026-11-01T01:00:00Z'),
  createdBy: 'u1', submittedBy: 'u2', inspectorId: 'u2',
  notes: 'Ghi chú nội bộ',
  criteria: allTrue,
  odo: 50000,
  vehicleInfo: {
    original: { make: 'TOYOTA', model: 'Vios', variant: '1.5G', color: 'Trắng', year: 2020, mileage: 40000 },
    confirmed: { make: 'TOYOTA', model: 'Vios', variant: '1.5G', color: 'Trắng', year: 2020, mileage: 50000 },
  },
  overviewPhotos: { FRONT: img('f'), REAR: img('r'), LEFT: img('l'), RIGHT: 'https://evil.example.com/x.jpg' },
  groups: getChecklist().map((def) => ({
    groupKey: def.key,
    note: 'nội bộ',
    passed: true,
    items: def.items.map((i) => ({ itemKey: i.key, result: 'PASS', note: 'ghi chú hạng mục', photos: [] })),
    photos: [img(`${def.key}`)],
    odometerPhoto: def.requiresOdometerPhoto ? img('odo') : null,
    minorDefects: def.key === 'G1_BODY_FRAME'
      ? [{ type: 'PAINT_SCRATCH_LIGHT', location: 'Cản trước', description: 'Xước nhẹ', photos: [img('d1')] }]
      : [],
  })),
});

describe('toInitials', () => {
  test.each([
    ['Nguyễn Văn An', 'N.V.A.'],
    ['  đặng   thị  hoa ', 'Đ.T.H.'],
    ['An', 'A.'],
    ['', null],
    [null, null],
  ])('%p → %p', (name, expected) => {
    expect(toInitials(name)).toBe(expected);
  });
});

describe('isPublicImageUrl', () => {
  test.each([
    [img('a'), true],
    [`https://res.cloudinary.com/${CLOUD}/image/upload/trustcar/cars/a.jpg`, true],
    [`https://res.cloudinary.com/${CLOUD}/image/upload/l_text:Arial_80:PASS/v1/trustcar/a.jpg`, false],
    [`https://res.cloudinary.com/${CLOUD}/image/upload/w_100/trustcar/a.jpg`, false],
    [`https://res.cloudinary.com/${CLOUD}/image/upload/c_fill,h_10/a.jpg`, false],
    ['https://res.cloudinary.com/other/image/upload/v1/a.jpg', false],
    ['https://evil.example.com/a.jpg', false],
    [`https://res.cloudinary.com/${CLOUD}/image/upload/v1/a.jpg?x=1`, false],
    [`https://res.cloudinary.com/${CLOUD}/image/upload/v1/../a.jpg`, false],
    [42, false],
  ])('%s → %s', (url, expected) => {
    expect(isPublicImageUrl(url)).toBe(expected);
  });
});

describe('buildPublicReport — FULL (digital checklist)', () => {
  const report = buildPublicReport({ car, record: fullRecord(), inspectorName: 'Nguyễn Văn An' });

  test('has exactly the public fields', () => {
    expect(Object.keys(report).sort()).toEqual(
      ['certificateId', 'groups', 'inspector', 'issuedAt', 'level', 'overviewPhotos', 'photos', 'scopeNote', 'vehicle'],
    );
    expect(Object.keys(report.vehicle).sort()).toEqual(['color', 'make', 'mileage', 'model', 'variant', 'year']);
    expect(Object.keys(report.groups[0]).sort()).toEqual(['items', 'key', 'label', 'minorDefects', 'passed', 'photos']);
    expect(Object.keys(report.groups[0].items[0]).sort()).toEqual(['key', 'label', 'result']);
    expect(Object.keys(report.groups[0].minorDefects[0]).sort()).toEqual(['description', 'label', 'location', 'photos', 'type']);
  });

  test('carries certificate, issue date, initials, confirmed vehicle and scope note', () => {
    expect(report).toMatchObject({
      certificateId: 'CPO-20261102-3F9A',
      issuedAt: '2026-11-02T08:15:00.000Z',
      level: 'FULL',
      inspector: 'N.V.A.',
      vehicle: { make: 'TOYOTA', mileage: 50000, color: 'Trắng' },
      photos: [],
      scopeNote: PUBLIC_REPORT_SCOPE_NOTE,
    });
  });

  test('5 groups in checklist order, with item labels, group photos and labelled minor defects', () => {
    expect(report.groups.map((g) => g.key)).toEqual(getChecklist().map((d) => d.key));
    expect(report.groups.every((g) => g.passed)).toBe(true);
    expect(report.groups[0].items[0]).toEqual({
      key: 'CHASSIS_RAILS', label: 'Dầm dọc, sắt xi trước/sau không biến dạng hay cắt hàn', result: 'PASS',
    });
    expect(report.groups[3].photos).toEqual([img('G4_ODOMETER'), img('odo')]);
    expect(report.groups[0].minorDefects[0]).toEqual({
      type: 'PAINT_SCRATCH_LIGHT', label: 'Xước sơn nhẹ', location: 'Cản trước', description: 'Xước nhẹ', photos: [img('d1')],
    });
  });

  test('drops non-project photos and never leaks internal data', () => {
    expect(report.overviewPhotos.RIGHT).toBeNull();
    const json = JSON.stringify(report);
    ['Ghi chú nội bộ', 'nội bộ', 'ghi chú hạng mục', '"u1"', '"u2"', '40000', '0900000000', 'evil.example.com', 'STAFF']
      .forEach((secret) => expect(json).not.toContain(secret));
    // The record id only appears inside photo URLs (Cloudinary folder), never as a field of its own.
    expect(json.replace(/https:\/\/[^"]+/g, '')).not.toContain(RID);
    expect(json).not.toMatch(/"(_id|id|carId|inspectorId|createdBy|submittedBy|publicId|notes|note|original)"/);
  });

  test('inspector is null when the name is unknown', () => {
    expect(buildPublicReport({ car, record: fullRecord() }).inspector).toBeNull();
  });
});

describe('buildPublicReport — MINIMAL (quick inspection / legacy)', () => {
  test('ADMIN_QUICK: 5 ticks from the booleans, flat photos, mileage from the inspection', () => {
    const report = buildPublicReport({
      car,
      record: {
        source: 'ADMIN_QUICK', cpoCertificateId: 'CPO-1', submittedAt: new Date('2026-11-02T00:00:00Z'),
        criteria: allTrue, odo: 51000, notes: 'nội bộ',
        evidenceImages: [img('q', 'trustcar/inspections/quick/c1')],
      },
      inspectorName: 'Lê Minh',
    });

    expect(report).toMatchObject({
      level: 'MINIMAL', inspector: 'L.M.', overviewPhotos: null,
      vehicle: { make: 'TOYOTA', model: 'Vios', variant: '1.5G', color: 'Trắng', year: 2020, mileage: 51000 },
      photos: [img('q', 'trustcar/inspections/quick/c1')],
    });
    expect(report.groups).toHaveLength(5);
    expect(report.groups.every((g) => g.passed && !g.items.length && !g.photos.length && !g.minorDefects.length))
      .toBe(true);
    expect(JSON.stringify(report)).not.toContain('nội bộ');
  });

  test('LEGACY (no source, no submittedAt): issued at createdAt, foreign photos dropped', () => {
    const report = buildPublicReport({
      car,
      record: {
        cpoCertificateId: 'CPO-2', createdAt: new Date('2026-10-01T03:00:00Z'), criteria: allTrue, odo: 45000,
        evidenceImages: ['https://evil.example.com/a.jpg', img('ok', 'trustcar/cars'), 'not a url'],
      },
    });

    expect(report).toMatchObject({ level: 'MINIMAL', issuedAt: '2026-10-01T03:00:00.000Z', inspector: null });
    expect(report.photos).toEqual([img('ok', 'trustcar/cars')]);
  });
});
