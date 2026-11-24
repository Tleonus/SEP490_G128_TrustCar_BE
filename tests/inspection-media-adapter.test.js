import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { v2 as cloudinary } from 'cloudinary';
import { CarStatus, InspectionStatus, Permissions } from '../src/constants/appConstants.js';
import { createInspectionMediaAdapter } from '../src/infra/inspection/inspectionMediaAdapter.js';
import { createInspectionUploadSigning } from '../src/usecase/inspection/signInspectionUpload.js';

const inspectionId = 'abcdef000000000000000001';
const carId = 'abcdef000000000000000002';
const cloud = 'fixture-cloud';
const fakeKey = 'fixture-key';
const fakeSigningSecret = 'fixture-for-local-signature-tests';
const clock = 1_731_234_567_987;
const actor = { id: 'abcdef000000000000000003', permissions: [Permissions.INSPECTION_WRITE] };
const draftFolder = `trustcar/inspections/${inspectionId}`;
const quickFolder = `trustcar/inspections/quick/${carId}`;
const origin = `https://res.cloudinary.com/${cloud}/image/upload`;

beforeEach(() => {
  jest.replaceProperty(process, 'env', {
    CLOUDINARY_CLOUD_NAME: cloud, CLOUDINARY_API_KEY: fakeKey, CLOUDINARY_API_SECRET: fakeSigningSecret,
  });
});
afterEach(() => jest.restoreAllMocks());

test('signs both fixed folders with the SDK, canonical ID, current timestamp and allowed formats', () => {
  const media = createInspectionMediaAdapter({ now: () => clock });
  const pairs = [
    [media.signInspectionPhoto(inspectionId.toUpperCase()), draftFolder],
    [media.signQuickInspectionPhoto(carId), quickFolder],
  ];
  const timestamp = Math.floor(clock / 1000);
  const allowedFormats = 'jpg,png,webp';
  for (const [result, folder] of pairs) {
    expect(result).toEqual({
      cloudName: cloud, apiKey: fakeKey, timestamp, folder, allowedFormats,
      signature: cloudinary.utils.api_sign_request(
        { timestamp, folder, allowed_formats: allowedFormats }, fakeSigningSecret,
      ),
    });
  }
});

test('fails closed for invalid signing IDs and missing media configuration', () => {
  const media = createInspectionMediaAdapter();
  expect(() => media.signInspectionPhoto('invalid')).toThrow(TypeError);
  delete process.env.CLOUDINARY_API_SECRET;
  expect(() => media.signInspectionPhoto(inspectionId)).toThrow(expect.objectContaining({
    code: 'UPLOAD_NOT_CONFIGURED', statusCode: 503,
  }));
});

test('accepts original uploads in only the correct folder, with or without a version', () => {
  const media = createInspectionMediaAdapter();
  expect(media.isInspectionImageUrl(`${origin}/v123/${draftFolder}/front.webp`, inspectionId)).toBe(true);
  expect(media.isInspectionImageUrl(`${origin}/${draftFolder}/m%C3%A0u.jpg`, inspectionId.toUpperCase())).toBe(true);
  expect(media.isQuickInspectionImageUrl(`${origin}/${quickFolder}/front.png`, carId)).toBe(true);
  expect(media.isInspectionImageUrl(`${origin}/${quickFolder}/front.png`, inspectionId)).toBe(false);
  expect(media.isQuickInspectionImageUrl(`${origin}/${draftFolder}/front.png`, carId)).toBe(false);
});

test.each([
  'transformed', 'nested', 'another cloud', 'another car', 'encoded separator', 'encoded whitespace', 'query',
])('rejects a URL with %s', (scenario) => {
  const urls = {
    transformed: `${origin}/l_text:Arial_80:test/${quickFolder}/front.jpg`,
    nested: `${origin}/${quickFolder}/child/front.jpg`,
    'another cloud': `https://res.cloudinary.com/other/image/upload/${quickFolder}/front.jpg`,
    'another car': `${origin}/trustcar/inspections/quick/${inspectionId}/front.jpg`,
    'encoded separator': `${origin}/${quickFolder}/child%2Ffront.jpg`,
    'encoded whitespace': `${origin}/${quickFolder}/a%20b.jpg`,
    query: `${origin}/${quickFolder}/front.jpg?x=1`,
  };
  expect(createInspectionMediaAdapter().isQuickInspectionImageUrl(urls[scenario], carId)).toBe(false);
});

function signingHarness({
  record = { id: inspectionId, status: InspectionStatus.DRAFT },
  car = { id: carId, status: CarStatus.UNDER_INSPECTION },
} = {}) {
  const records = { findById: jest.fn(async () => record) };
  const cars = { findById: jest.fn(async () => car) };
  const media = createInspectionMediaAdapter({ now: () => clock });
  return { ...createInspectionUploadSigning({ records, cars, media }), records, cars };
}

test('signs a DRAFT or an eligible car using the persisted resource ID', async () => {
  const h = signingHarness();
  await expect(h.signInspectionUpload(inspectionId.toUpperCase(), actor)).resolves.toMatchObject({ folder: draftFolder });
  await expect(h.signQuickInspectionUpload(carId.toUpperCase(), actor)).resolves.toMatchObject({ folder: quickFolder });
});

test.each(['PENDING_APPROVAL', InspectionStatus.SUBMITTED])('refuses to sign for a %s inspection', async (status) => {
  const h = signingHarness({ record: { id: inspectionId, status } });
  await expect(h.signInspectionUpload(inspectionId, actor)).rejects.toMatchObject({ code: 'INSPECTION_LOCKED' });
});

test('rejects a missing resource or an ineligible car', async () => {
  const h = signingHarness({ record: null, car: null });
  await expect(h.signInspectionUpload(inspectionId, actor)).rejects.toMatchObject({ code: 'INSPECTION_NOT_FOUND' });
  await expect(h.signQuickInspectionUpload(carId, actor)).rejects.toMatchObject({ code: 'CAR_NOT_FOUND' });
  const blocked = signingHarness({ car: { id: carId, status: CarStatus.AVAILABLE } });
  await expect(blocked.signQuickInspectionUpload(carId, actor)).rejects.toMatchObject({ code: 'INVALID_CAR_STATUS' });
});

test('checks permission and ObjectId before looking up resources', async () => {
  const h = signingHarness();
  const readOnly = { ...actor, permissions: [Permissions.INSPECTION_READ] };
  await expect(h.signInspectionUpload(inspectionId, readOnly)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(h.signQuickInspectionUpload(carId, readOnly)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(h.signQuickInspectionUpload('bad-id', actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  expect(h.records.findById).not.toHaveBeenCalled();
  expect(h.cars.findById).not.toHaveBeenCalled();
});
