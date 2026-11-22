/**
 * @file track-endpoint.test.js
 * @description KAN-97 — POST /api/v1/track: lưu VisitorSession + InteractionEvent,
 * validate carId, gắn customerId khi khách login, trả lại sessionId cho client.
 */

import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();

// Spy sau khi app đã import xong các model qua auth harness.
const { default: Car } = await import('../src/models/Car.js');
const { default: VisitorSession } = await import('../src/models/visitor-session.model.js');
const { default: InteractionEvent } = await import('../src/models/interaction-event.model.js');
const { default: User } = await import('../src/models/User.js');
const { signAccessToken } = await import('../src/utils/authTokens.js');
const mongoose = (await import('mongoose')).default;
const { jest } = await import('@jest/globals');
const spy = jest.spyOn;

const sessionStore = new Map();
const eventStore = [];

function fakeDoc(data) {
  const _id = data._id || new mongoose.Types.ObjectId();
  return { _id, ...data, toObject() { return { _id, ...data }; } };
}

const existingCarId = new mongoose.Types.ObjectId();

beforeEach(() => {
  h.reset();
  sessionStore.clear();
  eventStore.length = 0;
  // restoreAllMocks removed: would unmock the auth harness spies

  // Car.exists: chỉ existingCarId tồn tại.
  spy(Car, 'exists').mockImplementation(async (filter) => {
    const id = filter?._id || filter;
    return String(id) === String(existingCarId) ? { _id: id } : null;
  });

  // VisitorSession: in-memory store.
  spy(VisitorSession, 'findById').mockImplementation((id) => ({
    exec: async () => sessionStore.get(String(id)) || null,
    then(resolve, reject) { return this.exec().then(resolve, reject); },
  }));
  spy(VisitorSession, 'create').mockImplementation(async (data) => {
    const doc = fakeDoc({
      customerId: data.customerId || null,
      startedAt: data.startedAt || new Date(),
      lastSeenAt: data.lastSeenAt || new Date(),
    });
    sessionStore.set(String(doc._id), doc);
    return doc;
  });
  spy(VisitorSession, 'updateOne').mockImplementation(async (filter, update) => {
    const id = String(filter._id);
    const existing = sessionStore.get(id);
    if (!existing) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(existing, update.$set || {});
    return { matchedCount: 1, modifiedCount: 1 };
  });

  // InteractionEvent.create: in-memory + validate đi qua schema thật.
  spy(InteractionEvent, 'create').mockImplementation(async (data) => {
    const doc = new InteractionEvent(data);
    const err = doc.validateSync();
    if (err) throw err;
    const raw = doc.toObject();
    eventStore.push(raw);
    return { _id: raw._id, ...raw, toObject: () => raw };
  });
});

const post = (body, auth) => {
  const req = request(h.app).post('/api/v1/track').set('X-Forwarded-For', h.nextIp());
  if (auth) req.set('Authorization', auth);
  return req.send(body);
};

describe('POST /api/v1/track', () => {
  test('tạo VisitorSession mới khi không gửi sessionId, trả session+event id', async () => {
    const res = await post({ eventType: 'VIEW_CAR', carId: String(existingCarId) });
    expect(res.status).toBe(201);
    expect(res.body.data.sessionId).toMatch(/^[0-9a-f]{24}$/);
    expect(res.body.data.eventId).toMatch(/^[0-9a-f]{24}$/);
    expect(sessionStore.size).toBe(1);
    expect(eventStore).toHaveLength(1);
    expect(eventStore[0]).toMatchObject({ eventType: 'VIEW_CAR', carId: existingCarId });
  });

  test('dùng lại session khi client gửi sessionId đã tồn tại', async () => {
    const first = await post({ eventType: 'VIEW_CAR', carId: String(existingCarId) });
    const { sessionId } = first.body.data;
    const second = await post({ eventType: 'VIEW_CAR', carId: String(existingCarId), sessionId });
    expect(second.status).toBe(201);
    expect(second.body.data.sessionId).toBe(sessionId);
    expect(sessionStore.size).toBe(1);
    expect(eventStore).toHaveLength(2);
  });

  test('khách đã đăng nhập → session được gắn customerId', async () => {
    // Dùng ObjectId đơn giản làm customer ref — không cần Customer record thật,
    // vì optionalAuth chỉ gán req.user.customer từ user document.
    const customerId = new mongoose.Types.ObjectId();
    const { id } = await h.createUser({ roleName: 'CUSTOMER', phone: '0909000113', customer: customerId });
    const user = await User.findById(id).select('+tokenVersion');
    const token = signAccessToken(user);

    await post({ eventType: 'VIEW_CAR', carId: String(existingCarId) }, `Bearer ${token}`);

    expect(sessionStore.size).toBe(1);
    const [session] = [...sessionStore.values()];
    expect(String(session.customerId)).toBe(String(customerId));
  });

  test('eventType ngoài whitelist → 422', async () => {
    const res = await post({ eventType: 'HACK', carId: String(existingCarId) });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(eventStore).toHaveLength(0);
  });

  test('VIEW_CAR thiếu carId → 422', async () => {
    const res = await post({ eventType: 'VIEW_CAR' });
    expect(res.status).toBe(422);
    expect(eventStore).toHaveLength(0);
  });

  test('FILTER_APPLY không có carId → 201', async () => {
    const res = await post({ eventType: 'FILTER_APPLY' });
    expect(res.status).toBe(201);
    expect(eventStore[0].carId).toBeNull();
  });

  test('carId không tồn tại → 404, không ghi event rác', async () => {
    const ghost = new mongoose.Types.ObjectId();
    const res = await post({ eventType: 'VIEW_CAR', carId: String(ghost) });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CAR_NOT_FOUND');
    expect(eventStore).toHaveLength(0);
  });

  test('metadata > 1KB → 422', async () => {
    const big = { data: 'x'.repeat(1100) };
    const res = await post({ eventType: 'FILTER_APPLY', metadata: big });
    expect(res.status).toBe(422);
  });

  test('tham số lạ → 422 (schema strict)', async () => {
    const res = await post({ eventType: 'VIEW_CAR', carId: String(existingCarId), hacker: 1 });
    expect(res.status).toBe(422);
  });
});
