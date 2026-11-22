/**
 * @file lead-scoring-service.test.js
 * @description KAN-97 — runLeadScoring: ghép event ↔ lead qua session.customerId,
 * cập nhật score/scoreBand, chỉ ghi ActivityLog khi band đổi, idempotent khi chạy
 * lại cùng dữ liệu, bỏ lead WON/LOST/inactive, decay kéo score cũ về 0 khi hết event.
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import Lead from '../src/models/Lead.js';
import ActivityLog from '../src/models/ActivityLog.js';
import { runLeadScoring } from '../src/services/leadScoringService.js';

const NOW = new Date('2026-12-05T00:00:00Z');
const daysAgo = (days) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
const oid = () => new mongoose.Types.ObjectId();

const makeEvent = (eventType, { carId = null, sessionId = null, occurredAt = NOW } = {}) => ({
  _id: oid(), eventType, carId, sessionId, occurredAt, metadata: null,
});
const makeSession = (customerId) => ({ _id: oid(), customerId, startedAt: NOW, lastSeenAt: NOW });
const makeLead = ({ customer, car = null, stage = 'NEW', score = 0, scoreBand = 'COLD', lastScoredAt = null, leadCode = 'LD-0001' } = {}) => ({
  _id: oid(), leadCode, customer, car, stage, score, scoreBand, lastScoredAt, isActive: true,
});

let leadStore;
let activityLogs;
let loaderPayload;

beforeEach(() => {
  leadStore = [];
  activityLogs = [];
  loaderPayload = { events: [], sessions: [] };

  jest.spyOn(Lead, 'find').mockImplementation((filter) => ({
    lean: async () => leadStore.filter((lead) => matchesLeadFilter(lead, filter)),
  }));
  jest.spyOn(Lead, 'updateOne').mockImplementation(async (filter, update) => {
    const lead = leadStore.find((l) => String(l._id) === String(filter._id));
    if (lead) Object.assign(lead, update.$set || {});
    return { matchedCount: lead ? 1 : 0 };
  });
  jest.spyOn(ActivityLog, 'create').mockImplementation(async (entry) => {
    activityLogs.push(entry);
    return entry;
  });
});

afterEach(() => jest.restoreAllMocks());

const loader = async () => loaderPayload;

function matchesLeadFilter(lead, filter) {
  if (filter.isActive && lead.isActive !== true) return false;
  if (filter.stage?.$in && !filter.stage.$in.includes(lead.stage)) return false;
  if (!filter.$or) return true;
  return filter.$or.some((clause) => {
    if (clause.customer?.$in) return clause.customer.$in.some((id) => String(id) === String(lead.customer));
    if (clause.score?.$gt !== undefined) {
      if (!(lead.score > clause.score.$gt)) return false;
      if (clause.$or) {
        return clause.$or.some((sub) => {
          if (sub.lastScoredAt === null) return lead.lastScoredAt == null;
          if (sub.lastScoredAt?.$lt) return lead.lastScoredAt && lead.lastScoredAt < sub.lastScoredAt.$lt;
          return false;
        });
      }
      return true;
    }
    return false;
  });
}

describe('runLeadScoring', () => {
  it('DoD: 5 VIEW_CAR + 1 WISHLIST_ADD qua 2 session cùng customer → lead HOT', async () => {
    const customerId = oid();
    const carX = oid();
    const session1 = makeSession(customerId);
    const session2 = makeSession(customerId);
    const lead = makeLead({ customer: customerId, car: carX });
    leadStore.push(lead);
    loaderPayload = {
      sessions: [session1, session2],
      events: [
        ...Array.from({ length: 3 }, () => makeEvent('VIEW_CAR', { carId: carX, sessionId: session1._id })),
        ...Array.from({ length: 2 }, () => makeEvent('VIEW_CAR', { carId: carX, sessionId: session2._id })),
        makeEvent('WISHLIST_ADD', { carId: carX, sessionId: session2._id }),
      ],
    };

    const result = await runLeadScoring({ now: NOW, loader });

    expect(result).toMatchObject({ scored: 1, hot: 1, warm: 0, cold: 0 });
    expect(lead).toMatchObject({ score: 75, scoreBand: 'HOT' });
    expect(lead.scoreFactors).toMatchObject({ VIEW_CAR: 5, WISHLIST_ADD: 1 });
    expect(lead.lastScoredAt).toEqual(NOW);
  });

  it('ghi đúng 1 ActivityLog LEAD_SCORE_UPDATED khi band đổi COLD → HOT', async () => {
    const customerId = oid();
    const carX = oid();
    const session = makeSession(customerId);
    leadStore.push(makeLead({ customer: customerId, car: carX }));
    loaderPayload = {
      sessions: [session],
      events: Array.from({ length: 8 }, () => makeEvent('VIEW_CAR', { carId: carX, sessionId: session._id })),
    };

    await runLeadScoring({ now: NOW, loader });

    expect(activityLogs).toHaveLength(1);
    expect(activityLogs[0]).toMatchObject({
      eventType: 'LEAD_SCORE_UPDATED',
      performedBy: null,
      targetModel: 'Lead',
    });
    expect(activityLogs[0].metadata).toMatchObject({ previousBand: 'COLD', scoreBand: 'HOT' });
  });

  it('không log khi điểm đổi trong cùng band (76 → 80 vẫn HOT)', async () => {
    const customerId = oid();
    const carX = oid();
    const session = makeSession(customerId);
    leadStore.push(makeLead({
      customer: customerId, car: carX, score: 76, scoreBand: 'HOT',
      lastScoredAt: daysAgo(1),
    }));
    loaderPayload = {
      sessions: [session],
      events: Array.from({ length: 8 }, () => makeEvent('VIEW_CAR', { carId: carX, sessionId: session._id })),
    };

    await runLeadScoring({ now: NOW, loader });

    expect(activityLogs).toHaveLength(0);
    expect(leadStore[0]).toMatchObject({ score: 80, scoreBand: 'HOT' });
  });

  it('idempotent: 2 lần chạy liên tiếp cho cùng kết quả', async () => {
    const customerId = oid();
    const carX = oid();
    const session = makeSession(customerId);
    leadStore.push(makeLead({ customer: customerId, car: carX }));
    loaderPayload = {
      sessions: [session],
      events: [
        ...Array.from({ length: 5 }, () => makeEvent('VIEW_CAR', { carId: carX, sessionId: session._id })),
        makeEvent('WISHLIST_ADD', { carId: carX, sessionId: session._id }),
      ],
    };

    await runLeadScoring({ now: NOW, loader });
    const firstPass = { score: leadStore[0].score, scoreBand: leadStore[0].scoreBand };
    activityLogs.length = 0;

    const result = await runLeadScoring({ now: NOW, loader });

    expect({ score: leadStore[0].score, scoreBand: leadStore[0].scoreBand }).toEqual(firstPass);
    expect(result.skipped).toBe(1);
    expect(activityLogs).toHaveLength(0);
  });

  it('lead đã WON không bị chấm lại (filter loại bỏ)', async () => {
    const customerId = oid();
    const session = makeSession(customerId);
    leadStore.push(makeLead({ customer: customerId, score: 55, scoreBand: 'WARM', stage: 'WON' }));
    loaderPayload = { sessions: [session], events: [makeEvent('WISHLIST_ADD', { sessionId: session._id, carId: oid() })] };

    await runLeadScoring({ now: NOW, loader });

    expect(leadStore[0]).toMatchObject({ score: 55, scoreBand: 'WARM' });
  });

  it('khách có 2 lead (xe X và xe Y), chỉ event xe X được tính vào lead X', async () => {
    const customerId = oid();
    const carX = oid();
    const carY = oid();
    const session = makeSession(customerId);
    const leadX = makeLead({ customer: customerId, car: carX, leadCode: 'LD-0001' });
    const leadY = makeLead({ customer: customerId, car: carY, leadCode: 'LD-0002' });
    leadStore.push(leadX, leadY);
    loaderPayload = {
      sessions: [session],
      events: Array.from({ length: 8 }, () => makeEvent('VIEW_CAR', { carId: carX, sessionId: session._id })),
    };

    await runLeadScoring({ now: NOW, loader });

    expect(leadX).toMatchObject({ score: 80, scoreBand: 'HOT' });
    expect(leadY).toMatchObject({ score: 0, scoreBand: 'COLD' });
  });

  it('decay: lead cũ 75đ, event 8 ngày tuổi, không event mới → score trượt về 68', async () => {
    const customerId = oid();
    const carX = oid();
    const session = makeSession(customerId);
    leadStore.push(makeLead({
      customer: customerId, car: carX, score: 75, scoreBand: 'HOT', lastScoredAt: daysAgo(10),
    }));
    loaderPayload = {
      sessions: [session],
      events: [
        ...Array.from({ length: 5 }, () => makeEvent('VIEW_CAR', { carId: carX, sessionId: session._id, occurredAt: daysAgo(8) })),
        makeEvent('WISHLIST_ADD', { carId: carX, sessionId: session._id, occurredAt: daysAgo(8) }),
      ],
    };

    await runLeadScoring({ now: NOW, loader });

    expect(leadStore[0].score).toBe(68);
    expect(leadStore[0].scoreBand).toBe('WARM');
    expect(activityLogs).toHaveLength(1); // HOT → WARM
  });

  it('event của session không có customerId → bỏ qua, không throw', async () => {
    const customerId = oid();
    const orphanSession = { _id: oid(), customerId: null };
    const activeSession = makeSession(customerId);
    const carX = oid();
    leadStore.push(makeLead({ customer: customerId, car: carX }));
    loaderPayload = {
      sessions: [orphanSession, activeSession],
      events: [
        makeEvent('VIEW_CAR', { carId: carX, sessionId: orphanSession._id }),
        makeEvent('VIEW_CAR', { carId: carX, sessionId: activeSession._id }),
      ],
    };

    const result = await runLeadScoring({ now: NOW, loader });
    expect(result).toMatchObject({ scored: 1 });
    expect(leadStore[0].score).toBe(10); // chỉ event có customer được tính
  });

  it('lead cũ còn điểm nhưng khách im lặng → cron kéo vào chấm và score rơi về 0', async () => {
    const customerId = oid();
    leadStore.push(makeLead({
      customer: customerId, score: 50, scoreBand: 'WARM', lastScoredAt: daysAgo(10),
    }));
    loaderPayload = { sessions: [], events: [] };

    await runLeadScoring({ now: NOW, loader });

    expect(leadStore[0].score).toBe(0);
    expect(leadStore[0].scoreBand).toBe('COLD');
    expect(activityLogs).toHaveLength(1); // WARM → COLD
  });
});
