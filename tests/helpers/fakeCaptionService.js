/**
 * @file fakeCaptionService.js
 * @description Registers an in-memory stand-in for services/captionService so route
 * tests can run without a model call or a database.
 *
 * Kept in helpers/ on purpose: jest resolves a mocked specifier relative to the
 * module that registered it, and registrations made from a test file are resolved
 * against that file (which breaks `../../src/...` paths used elsewhere in the suite).
 * Registering from here keeps every mock in the same relative position.
 */

import { jest } from '@jest/globals';

export const captionServiceMock = {
  generateCaptions: jest.fn(async () => ({
    captions: ['option 1', 'option 2', 'option 3'],
    hashtags: ['#TrustCar'],
    imageSuggestion: { url: null, note: '' },
    cached: false,
    source: 'template',
    droppedCount: 0,
  })),
  Tones: { PROFESSIONAL: 'professional', FRIENDLY: 'friendly', URGENT: 'urgent' },
  Platforms: { FACEBOOK: 'facebook', ZALO: 'zalo' },
  Lengths: { SHORT: 'short', MEDIUM: 'medium' },
  CAPTION_TYPE: 'FB_CAPTION',
  OPTION_COUNT: 3,
};

jest.unstable_mockModule('../../src/services/captionService.js', () => captionServiceMock);

export default captionServiceMock;
