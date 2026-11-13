/**
 * @file caption.test.js
 * @description KAN-68 — Facebook caption suggestions.
 *
 * Covers the two things that can hurt the business: a caption that invents a
 * vehicle spec, and an endpoint that fails when the model is down or unconfigured.
 */

import { jest } from '@jest/globals';

// ── Fakes ────────────────────────────────────────────────────────────────────

const carStore = new Map();
const contentStore = [];

const carQuery = (car) => {
  const q = {
    select: () => q,
    lean: async () => (car ? structuredClone(car) : null),
    then: (ok, ko) => Promise.resolve(car).then(ok, ko),
  };
  return q;
};

jest.unstable_mockModule('../src/models/Car.js', () => ({
  default: { findById: (id) => carQuery(carStore.get(String(id))) },
}));

jest.unstable_mockModule('../src/models/content-item.model.js', () => ({
  default: {
    findOne: (filter) => ({
      lean: async () => contentStore.find((c) => c.type === filter.type && c.title === filter.title) || null,
    }),
    create: async (doc) => { contentStore.push(structuredClone(doc)); return doc; },
  },
}));

const llm = {
  configured: false,
  reply: null,
  fail: null,
  isConfigured: () => llm.configured,
  complete: jest.fn(async () => {
    if (llm.fail) throw new Error(llm.fail);
    return llm.reply;
  }),
};
jest.unstable_mockModule('../src/services/captionLlmClient.js', () => llm);

const { buildCaptionFacts } = await import('../src/services/captionFacts.js');
const { allowedNumbers, isGrounded, numbersIn } = await import('../src/services/captionGuard.js');
const { buildTemplateCaptions } = await import('../src/services/captionTemplates.js');
const captionService = await import('../src/services/captionService.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CAR_ID = '65f000000000000000000042';
const baseCar = {
  _id: CAR_ID,
  make: 'TOYOTA',
  model: 'Vios',
  variant: '1.5G',
  year: 2020,
  mileage: 50000,
  price: 520000000,
  transmission: 'AUTOMATIC',
  fuelType: 'GASOLINE',
  bodyType: 'SEDAN',
  conditionGrade: 'A',
  cpoCertificateId: 'CPO-20261102-3F9A',
  status: 'AVAILABLE',
  isActive: true,
  images: [{ url: 'https://res.cloudinary.com/demo/image/upload/v1/trustcar/cars/vios.jpg', isPrimary: true }],
};

const putCar = (overrides = {}) => { carStore.set(CAR_ID, { ...baseCar, ...overrides }); };
const facts = () => buildCaptionFacts(baseCar);
const llmReply = (captions, extra = {}) => JSON.stringify({ captions, hashtags: ['#TrustCar'], imageSuggestion: 'Ảnh nghiêng 3/4.', ...extra });

beforeEach(() => {
  carStore.clear();
  contentStore.length = 0;
  llm.configured = false;
  llm.reply = null;
  llm.fail = null;
  llm.complete.mockClear();
  putCar();
});

// ── Fact sheet ───────────────────────────────────────────────────────────────

describe('buildCaptionFacts', () => {
  test('maps stored values and never invents a field', () => {
    const f = facts();

    expect(f).toMatchObject({
      make: 'TOYOTA', model: 'Vios', year: 2020, mileage: 50000, price: 520000000,
      priceLabel: '520 triệu', transmission: 'số tự động', fuelType: 'xăng',
      bodyType: 'sedan', cpoCode: 'CPO-20261102-3F9A', criteriaCount: 5,
    });
    expect(f.imageUrl).toContain('vios.jpg');
    // No field that is not in the car document.
    expect(Object.keys(f).sort()).toEqual([
      'bodyType', 'conditionGrade', 'cpoCode', 'criteriaCount', 'fuelType', 'imageUrl',
      'make', 'mileage', 'model', 'price', 'priceLabel', 'transmission', 'variant', 'year',
    ]);
  });

  test('uncertified car has no CPO code and no criteria count', () => {
    const f = buildCaptionFacts({ ...baseCar, cpoCertificateId: null });

    expect(f.cpoCode).toBeNull();
    expect(f.criteriaCount).toBe(0);
  });

  test('social image wins over the primary image, and publicId is never exposed', () => {
    const f = buildCaptionFacts({
      ...baseCar,
      socialImage: { url: 'https://res.cloudinary.com/demo/image/upload/w_1200/social.jpg', publicId: 'secret' },
    });

    expect(f.imageUrl).toContain('social.jpg');
    expect(JSON.stringify(f)).not.toContain('secret');
  });
});

// ── Grounding guard ──────────────────────────────────────────────────────────

describe('captionGuard', () => {
  test('extracts every number token it is given', () => {
    expect(numbersIn('Xe 2020, 50.000 km, giá 520 triệu (~0,52 tỷ), mã CPO-20261102-3F9A')).toEqual(
      ['2020', '50.000', '520', '0,52', '20261102', '3', '9'],
    );
  });

  test('accepts every form of a stored number', () => {
    const allowed = allowedNumbers(facts());

    ['2020', '50.000', '50000', '520', '520000000', '0,52', '0.52', '1.5', '5']
      .forEach((t) => expect(isGrounded(`giá trị ${t}`, allowed)).toBe(true));
  });

  test.each([
    ['dung tích động cơ bịa', 'Vios 1.5G máy 2.0L cực khỏe'],
    ['số chỗ bịa', 'Xe 7 chỗ rộng rãi cho cả gia đình'],
    ['mức tiêu hao bịa', 'Chỉ tốn 5.2 lít/100km'],
    ['mức giảm giá bịa', 'Giảm ngay 30 triệu so với giá cũ'],
    ['số túi khí bịa', 'Trang bị 6 túi khí an toàn'],
    ['năm bịa', 'Xe sản xuất 2021 như mới'],
  ])('rejects a caption with an invented %s', (_label, caption) => {
    expect(isGrounded(caption, allowedNumbers(facts()))).toBe(false);
  });

  test('a caption with no numbers always passes', () => {
    expect(isGrounded('Xe gia đình đã kiểm định, mời anh chị ghé xem.', allowedNumbers(facts()))).toBe(true);
  });
});

// ── Templates ────────────────────────────────────────────────────────────────

describe('buildTemplateCaptions', () => {
  test('three grounded options for every tone × platform × length', () => {
    for (const tone of ['professional', 'friendly', 'urgent']) {
      for (const platform of ['facebook', 'zalo']) {
        for (const length of ['short', 'medium']) {
          const out = buildTemplateCaptions(facts(), { tone, platform, length });
          expect(out.captions).toHaveLength(3);
          out.captions.forEach((c) => expect(isGrounded(c, allowedNumbers(facts()))).toBe(true));
        }
      }
    }
  });

  test('short captions omit the detail and closer lines', () => {
    const [first] = buildTemplateCaptions(facts(), { length: 'short' }).captions;

    expect(first).not.toContain('km');
    expect(first).toContain('520 triệu');
  });

  test('hashtags come from the car, not from a fixed promo list', () => {
    const { hashtags } = buildTemplateCaptions(facts(), { platform: 'zalo' });

    expect(hashtags).toContain('#Vios');
    expect(hashtags).toContain('#CPO');
    expect(hashtags).toContain('#Zalo');
    expect(hashtags.every((t) => /^#\w+$/.test(t))).toBe(true);
  });
});

// ── Service ──────────────────────────────────────────────────────────────────

describe('generateCaptions', () => {
  const generate = (overrides = {}) => captionService.generateCaptions({
    carId: CAR_ID, userId: '65f000000000000000000001', ...overrides,
  });

  test('without an LLM key → three template captions, all grounded', async () => {
    const result = await generate();

    expect(result.source).toBe('template');
    expect(result.captions).toHaveLength(3);
    result.captions.forEach((c) => expect(isGrounded(c, allowedNumbers(facts()))).toBe(true));
    expect(result.imageSuggestion.url).toContain('vios.jpg');
    expect(result.cached).toBe(false);
  });

  test('LLM output with an invented spec is dropped and the list is topped up', async () => {
    llm.configured = true;
    llm.reply = llmReply([
      'Toyota Vios 2020 máy 2.0L, 50.000 km, giá 520 triệu.',   // invented 2.0L
      'Vios 2020 đã kiểm định 5 nhóm tiêu chí, giá 520 triệu.', // grounded
      'Xe 7 chỗ, giá 520 triệu.',                               // invented 7 chỗ
    ]);

    const result = await generate();

    expect(result.droppedCount).toBe(2);
    expect(result.captions).toHaveLength(3);
    expect(result.captions[0]).toContain('5 nhóm tiêu chí');
    expect(result.captions.join(' ')).not.toContain('2.0L');
    expect(result.captions.join(' ')).not.toContain('7 chỗ');
  });

  test('LLM failure falls back to templates instead of erroring', async () => {
    llm.configured = true;
    llm.fail = 'upstream 500';

    const result = await generate();

    expect(result.source).toBe('template');
    expect(result.captions).toHaveLength(3);
  });

  test('malformed LLM reply falls back to templates', async () => {
    llm.configured = true;
    llm.reply = 'Xin lỗi, tôi không thể tạo nội dung.';

    const result = await generate();

    expect(result.captions).toHaveLength(3);
    expect(result.source).toBe('template');
  });

  test('fenced JSON is still parsed', async () => {
    llm.configured = true;
    llm.reply = '```json\n' + llmReply(['Vios 2020, 50.000 km, giá 520 triệu.']) + '\n```';

    const result = await generate();

    // One surviving option → topped up from templates, so the mix is reported honestly.
    expect(result.source).toBe('mixed');
    expect(result.captions[0]).toContain('Vios 2020');
    expect(result.captions).toHaveLength(3);
  });

  test('a second identical request is served from cache and does not call the model', async () => {
    llm.configured = true;
    llm.reply = llmReply(['Vios 2020, 50.000 km, giá 520 triệu.']);

    const first = await generate();
    const second = await generate();

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.captions).toEqual(first.captions);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(contentStore).toHaveLength(1);
    expect(contentStore[0].type).toBe('FB_CAPTION');
    expect(contentStore[0].linkUrl).toBe(CAR_ID);
  });

  test('changing the price invalidates the cache', async () => {
    llm.configured = true;
    llm.reply = llmReply(['Vios 2020, giá 520 triệu.']);
    await generate();

    putCar({ price: 495000000 });
    const result = await generate({});

    expect(result.cached).toBe(false);
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });

  test('different tone/platform/length are cached separately', async () => {
    await generate({ tone: 'friendly' });
    await generate({ tone: 'urgent' });
    await generate({ tone: 'friendly', platform: 'zalo' });

    expect(contentStore).toHaveLength(3);
  });

  test('missing or inactive car → 404 CAR_NOT_FOUND', async () => {
    await expect(generate({ carId: '65f000000000000000000099' }))
      .rejects.toMatchObject({ statusCode: 404, code: 'CAR_NOT_FOUND' });

    putCar({ isActive: false });
    await expect(generate())
      .rejects.toMatchObject({ statusCode: 404, code: 'CAR_NOT_FOUND' });
  });

  test.each(['SOLD', 'HIDDEN', 'UNDER_INSPECTION'])('%s car → 422 CAR_NOT_ADVERTISABLE', async (status) => {
    putCar({ status });

    await expect(generate()).rejects.toMatchObject({ statusCode: 422, code: 'CAR_NOT_ADVERTISABLE' });
  });

  test('hashtags carrying an invented number are replaced', async () => {
    llm.configured = true;
    llm.reply = llmReply(['Vios 2020, 50.000 km, giá 520 triệu.'], { hashtags: ['#Giam30Trieu', '#2024'] });

    const result = await generate();

    expect(result.hashtags.join(' ')).not.toContain('Giam30Trieu');
    expect(result.hashtags.some((t) => t.includes('Vios'))).toBe(true);
  });
});
