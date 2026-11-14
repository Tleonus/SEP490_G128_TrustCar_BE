/**
 * @file public-chat.test.js
 * @description Unit & integration tests for the Hybrid-AI Public Chatbot (/api/v1/public/chat).
 * Uses in-memory fakes/spies — never touches a real MongoDB database.
 */

import { jest } from '@jest/globals';

const mockCars = [
  {
    _id: '65f000000000000000000101',
    vehicleCode: 'TC-2026-0001',
    make: 'MAZDA',
    model: 'CX-5',
    variant: '2.0 Premium',
    year: 2022,
    bodyType: 'SUV',
    fuelType: 'GASOLINE',
    transmission: 'AUTOMATIC',
    mileage: 28000,
    price: 685000000,
    floorPrice: 640000000,
    originalPrice: 650000000,
    vin: 'JM7KF2W7A00123456',
    internalNotes: 'Secret staff note',
    status: 'AVAILABLE',
    isActive: true,
    cpoCertificateId: 'CPO-2026-0001',
    images: [{ _id: 'img1', url: 'https://example.com/cx5.jpg', publicId: 'sec1', isPrimary: true }],
  },
  {
    _id: '65f000000000000000000102',
    vehicleCode: 'TC-2026-0002',
    make: 'TOYOTA',
    model: 'Camry',
    variant: '2.5Q',
    year: 2021,
    bodyType: 'SEDAN',
    fuelType: 'GASOLINE',
    transmission: 'AUTOMATIC',
    mileage: 35000,
    price: 920000000,
    status: 'AVAILABLE',
    isActive: true,
    cpoCertificateId: null,
    images: [{ _id: 'img2', url: 'https://example.com/camry.jpg', publicId: 'sec2', isPrimary: true }],
  },
];

const conversationStore = [];
const messageStore = [];
const enquiryCalls = [];

jest.unstable_mockModule('../src/models/Car.js', () => ({
  default: {
    findOne: jest.fn((filter) => ({
      lean: async () => {
        const match = mockCars.find(
          (c) => !filter.vehicleCode || c.vehicleCode === filter.vehicleCode
        );
        return match ? structuredClone(match) : null;
      },
    })),
    find: jest.fn((filter) => {
      const q = {
        sort: () => q,
        limit: () => q,
        lean: async () => {
          let list = mockCars.filter((c) => c.status === 'AVAILABLE' && c.isActive);
          if (filter.bodyType) {
            list = list.filter((c) => c.bodyType === filter.bodyType);
          }
          if (filter.price?.$lte) {
            list = list.filter((c) => c.price <= filter.price.$lte);
          }
          if (filter.price?.$gte) {
            list = list.filter((c) => c.price >= filter.price.$gte);
          }
          return structuredClone(list);
        },
      };
      return q;
    }),
  },
}));

jest.unstable_mockModule('../src/models/chat-conversation.model.js', () => ({
  default: {
    findOneAndUpdate: jest.fn((filter, update) => ({
      lean: async () => {
        const doc = {
          _id: '65f000000000000000000999',
          conversationCode: filter.conversationCode,
          ...(update.$setOnInsert || {}),
          ...(update.$set || {}),
        };
        conversationStore.push(doc);
        return doc;
      },
    })),
  },
}));

jest.unstable_mockModule('../src/models/chat-message.model.js', () => ({
  default: {
    insertMany: jest.fn(async (docs) => {
      messageStore.push(...docs);
      return docs;
    }),
  },
}));

jest.unstable_mockModule('../src/services/baseSettingsService.js', () => ({
  getBaseSettings: jest.fn(async () => ({
    contact: {
      showroomName: 'Showroom TrustCar',
      address: 'Quận 1, TP. Hồ Chí Minh',
      phone: '0856098686',
      phoneDisplay: '0856 098 686',
      phoneHref: 'tel:0856098686',
      email: 'support@trustcar.vn',
      showroomDisplay: 'Showroom TrustCar, Quận 1, TP. Hồ Chí Minh',
      showroomHours: '08:00 - 20:00 vào ngày mở cửa',
    },
    testDrive: {
      openTime: '09:00',
      closeTime: '17:00',
      slotDurationMinutes: 60,
    },
  })),
}));

jest.unstable_mockModule('../src/services/loanSettingsService.js', () => ({
  getLoanSettings: jest.fn(async () => ({
    preferredRateAnnual: 8.5,
    floatingRateAnnual: 10.5,
    minDownPaymentPct: 20,
    minTermMonths: 12,
    maxTermMonths: 84,
  })),
}));

jest.unstable_mockModule('../src/services/leadService.js', () => ({
  createPublicEnquiry: jest.fn(async (payload) => {
    enquiryCalls.push(payload);
    return {
      leadCode: 'LD-0099',
      stage: 'NEW',
      createdAt: new Date(),
    };
  }),
}));

const {
  parsePriceRangeFromText,
  extractEntitiesFromSingleText,
  analyzeConversationTurn,
  computeLoanEstimate,
  processPublicChatMessage,
} = await import('../src/services/chatService.js');

const { sendChatMessageSchema } = await import('../src/routes/publicChatRoutes.js');

beforeEach(() => {
  conversationStore.length = 0;
  messageStore.length = 0;
  enquiryCalls.length = 0;
  delete process.env.CHAT_LLM_API_KEY;
  delete process.env.CAPTION_LLM_API_KEY;
});

describe('NLU price & entity extraction', () => {
  test('parses Vietnamese ceiling, floor, range, and approximate prices', () => {
    expect(parsePriceRangeFromText('Tìm xe SUV dưới 700 triệu')).toMatchObject({
      priceMax: 700_000_000,
    });

    expect(parsePriceRangeFromText('Xe từ 500 đến 800 triệu')).toMatchObject({
      priceMin: 500_000_000,
      priceMax: 800_000_000,
    });

    expect(parsePriceRangeFromText('Ngân sách dưới 1 tỷ 2')).toMatchObject({
      priceMax: 1_200_000_000,
    });
  });

  test('extracts brand, model, bodyType, transmission, and fuelType', () => {
    const entities = extractEntitiesFromSingleText(
      'Tìm Mazda CX-5 gầm cao máy xăng số tự động đời 2022 dưới 750 triệu'
    );
    expect(entities).toMatchObject({
      brand: 'Mazda',
      model: 'CX-5',
      bodyType: 'SUV',
      fuelType: 'GASOLINE',
      transmission: 'AUTOMATIC',
      yearMin: 2022,
      priceMax: 750_000_000,
    });
  });

  test('carries over filter context from conversation history on follow-up questions', () => {
    const history = [{ role: 'user', content: 'Tìm xe SUV Mazda CX-5' }];
    const turn = analyzeConversationTurn('Dưới 700 triệu số tự động thì sao?', history);

    expect(turn.filters.brand).toBe('Mazda');
    expect(turn.filters.bodyType).toBe('SUV');
    expect(turn.filters.priceMax).toBe(700_000_000);
    expect(turn.filters.transmission).toBe('AUTOMATIC');
  });
});

describe('Loan calculator grounding', () => {
  test('computes monthly installment from loanSettings configuration', () => {
    const estimate = computeLoanEstimate(
      'Tính trả góp 700 triệu trả trước 30% trong 5 năm',
      { preferredRateAnnual: 8.5, floatingRateAnnual: 10.5, minDownPaymentPct: 20, minTermMonths: 12, maxTermMonths: 84 }
    );

    expect(estimate.vehiclePrice).toBe(700_000_000);
    expect(estimate.downPaymentPct).toBe(30);
    expect(estimate.downPaymentAmount).toBe(210_000_000);
    expect(estimate.loanPrincipal).toBe(490_000_000);
    expect(estimate.termMonths).toBe(60);
    expect(estimate.monthlyPayment).toBeGreaterThan(9_000_000);
    expect(estimate.monthlyPayment).toBeLessThan(11_000_000);
  });
});

describe('processPublicChatMessage', () => {
  test('queries available cars, strips confidential fields, and persists conversation & messages', async () => {
    const res = await processPublicChatMessage({
      message: 'Tìm xe SUV dưới 700 triệu',
      sessionId: 'tc-session-test-001',
      history: [],
    });

    expect(res.intent).toBe('CAR_SEARCH');
    expect(res.cars).toHaveLength(1);
    expect(res.cars[0].vehicleCode).toBe('TC-2026-0001');
    // Confidential fields must never leak to public chat cards
    expect(res.cars[0].floorPrice).toBeUndefined();
    expect(res.cars[0].originalPrice).toBeUndefined();
    expect(res.cars[0].vin).toBeUndefined();
    expect(res.cars[0].internalNotes).toBeUndefined();
    expect(res.reply).toContain('CX-5');
    expect(res.source).toBe('hybrid-grounded');

    // Persisted in ChatConversation & ChatMessage
    expect(conversationStore).toHaveLength(1);
    expect(conversationStore[0].conversationCode).toBe('tc-session-test-001');
    expect(messageStore).toHaveLength(2);
    expect(messageStore[0].senderType).toBe('CUSTOMER');
    expect(messageStore[1].senderType).toBe('AI');
  });

  test('captures a CRM Lead automatically when customer provides a valid Vietnamese phone number', async () => {
    const res = await processPublicChatMessage({
      message: 'Mình là Minh, tư vấn giúp mình mẫu CX-5 qua số 0901234567 nhé',
      sessionId: 'tc-session-lead-002',
    });

    expect(res.intent).toBe('LEAD_PHONE');
    expect(res.leadCaptured).toEqual({
      phone: '0901234567',
      leadCode: 'LD-0099',
    });
    expect(enquiryCalls).toHaveLength(1);
    expect(enquiryCalls[0].phone).toBe('0901234567');
    expect(res.reply).toContain('0901234567');
    expect(res.reply).toContain('LD-0099');
  });

  test('uses Hybrid LLM completion when configured and falls back cleanly on LLM error', async () => {
    const mockFetchOk = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: 'Dạ hiện tại TrustCar đang có sẵn mẫu Mazda CX-5 2.0 Premium 2022 giá 685 triệu đạt chuẩn CPO ạ.',
                followUps: ['Xem chi tiết Mazda CX-5', 'Tính trả góp CX-5'],
              }),
            },
          },
        ],
      }),
    }));

    const llmRes = await processPublicChatMessage(
      { message: 'Tìm xe SUV dưới 700 triệu', sessionId: 'tc-session-llm-1' },
      { llmOptions: { apiKey: 'test-key', fetchImpl: mockFetchOk } }
    );

    expect(llmRes.source).toBe('hybrid-llm');
    expect(llmRes.reply).toContain('Mazda CX-5 2.0 Premium 2022');
    expect(llmRes.followUps).toEqual(['Xem chi tiết Mazda CX-5', 'Tính trả góp CX-5']);

    // Now simulate LLM failure -> must fall back to deterministic grounded response
    const mockFetchFail = jest.fn(async () => ({ ok: false, status: 503 }));
    const fallbackRes = await processPublicChatMessage(
      { message: 'Tìm xe SUV dưới 700 triệu', sessionId: 'tc-session-llm-2' },
      { llmOptions: { apiKey: 'test-key', fetchImpl: mockFetchFail } }
    );

    expect(fallbackRes.source).toBe('hybrid-grounded');
    expect(fallbackRes.reply).toContain('CX-5');
  });
});

describe('sendChatMessageSchema validation', () => {
  test('validates required message and optional sessionId/history', () => {
    const { error: emptyErr } = sendChatMessageSchema.validate({ message: '   ' });
    expect(emptyErr).toBeDefined();

    const { error: validErr, value } = sendChatMessageSchema.validate({
      message: 'Xin chào TrustCar',
      sessionId: 'tc-session-123',
      history: [{ role: 'user', content: 'Hello' }],
    });
    expect(validErr).toBeUndefined();
    expect(value.message).toBe('Xin chào TrustCar');
  });
});

