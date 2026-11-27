/**
 * @file lead-scoring-rules.test.js
 * @description KAN-97 — pure rule tests. DB không chạm; xoay quanh contribution,
 * ghép event theo car/lead, decay, cửa sổ 30 ngày, band ranh giới và DoD "5x view + 1x save → HOT".
 */

import mongoose from 'mongoose';
import { bandOf, contributionOf, eventsForLead, scoreLead } from '../src/services/leadScoringRules.js';

const NOW = new Date('2026-12-05T00:00:00Z');
const daysAgo = (days) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
const event = (eventType, { carId = null, leadId = null, occurredAt = NOW } = {}) =>
  ({ eventType, carId, leadId, occurredAt });
const lead = ({ car = null } = {}) => ({ _id: new mongoose.Types.ObjectId(), car });

describe('bandOf', () => {
  it.each([
    [0, 'COLD'], [29, 'COLD'], [30, 'WARM'], [50, 'WARM'],
    [70, 'WARM'], [71, 'HOT'], [100, 'HOT'],
  ])('score %i → %s', (score, expected) => {
    expect(bandOf(score)).toBe(expected);
  });
});

describe('contributionOf', () => {
  const carX = new mongoose.Types.ObjectId();

  it('event lạ trả 0', () => {
    expect(contributionOf(event('HACK', { carId: carX }), NOW)).toBe(0);
  });

  it('VIEW_CAR tuổi 0 với leadCarId khớp → full weight 10', () => {
    expect(contributionOf(event('VIEW_CAR', { carId: carX }), NOW, { leadCarId: carX })).toBe(10);
  });

  it('VIEW_CAR tuổi 8 ngày → 10 × 0.9 = 9', () => {
    const ev = event('VIEW_CAR', { carId: carX, occurredAt: daysAgo(8) });
    expect(contributionOf(ev, NOW, { leadCarId: carX })).toBeCloseTo(9);
  });

  it('VIEW_CAR tuổi 15 ngày → 10 × 0.81 = 8.1', () => {
    const ev = event('VIEW_CAR', { carId: carX, occurredAt: daysAgo(15) });
    expect(contributionOf(ev, NOW, { leadCarId: carX })).toBeCloseTo(8.1);
  });

  it('VIEW_CAR tuổi 31 ngày → 0 (ngoài cửa sổ 30 ngày)', () => {
    const ev = event('VIEW_CAR', { carId: carX, occurredAt: daysAgo(31) });
    expect(contributionOf(ev, NOW, { leadCarId: carX })).toBe(0);
  });

  it('FILTER_APPLY (không carId) → 3 × 0.5 = 1.5', () => {
    expect(contributionOf(event('FILTER_APPLY'), NOW)).toBeCloseTo(1.5);
  });

  it('event xe khác lead → 0', () => {
    const carY = new mongoose.Types.ObjectId();
    const ev = event('VIEW_CAR', { carId: carY });
    expect(contributionOf(ev, NOW, { leadCarId: carX })).toBe(0);
  });
});

describe('eventsForLead', () => {
  const carX = new mongoose.Types.ObjectId();
  const carY = new mongoose.Types.ObjectId();
  const leadX = lead({ car: carX });

  it('leadId khớp được nhận dù khác car', () => {
    const ev = event('VIEW_CAR', { carId: carY, leadId: leadX._id });
    expect(eventsForLead([ev], leadX)).toHaveLength(1);
  });

  it('leadId khác bị loại hẳn, không rơi về match theo car', () => {
    const other = new mongoose.Types.ObjectId();
    const ev = event('VIEW_CAR', { carId: carX, leadId: other });
    expect(eventsForLead([ev], leadX)).toHaveLength(0);
  });

  it('event không có leadId: match theo car', () => {
    const matched = event('VIEW_CAR', { carId: carX });
    const unmatched = event('VIEW_CAR', { carId: carY });
    expect(eventsForLead([matched, unmatched], leadX)).toEqual([matched]);
  });

  it('lead car=null nhận mọi event có carId', () => {
    const anonymousLead = lead({ car: null });
    const ev = event('VIEW_CAR', { carId: carX });
    expect(eventsForLead([ev], anonymousLead)).toHaveLength(1);
  });

  it('event không gắn car được nhận cho mọi lead', () => {
    const ev = event('FILTER_APPLY');
    expect(eventsForLead([ev], leadX)).toHaveLength(1);
  });
});

describe('scoreLead — DoD + biên', () => {
  const carX = new mongoose.Types.ObjectId();
  const buildLead = () => lead({ car: carX });

  it('DoD: 5 × VIEW_CAR + 1 × WISHLIST_ADD cùng xe → 75 → HOT', () => {
    const events = [
      ...Array.from({ length: 5 }, () => event('VIEW_CAR', { carId: carX })),
      event('WISHLIST_ADD', { carId: carX }),
    ];
    const result = scoreLead(buildLead(), events, NOW);
    expect(result).toMatchObject({ score: 75, scoreBand: 'HOT' });
    expect(result.factors).toMatchObject({ VIEW_CAR: 5, WISHLIST_ADD: 1 });
  });

  it('chỉ WISHLIST_ADD → 25 → COLD', () => {
    const events = [event('WISHLIST_ADD', { carId: carX })];
    expect(scoreLead(buildLead(), events, NOW)).toMatchObject({ score: 25, scoreBand: 'COLD' });
  });

  it('3 × VIEW_CAR → 30 → WARM (biên dưới)', () => {
    const events = Array.from({ length: 3 }, () => event('VIEW_CAR', { carId: carX }));
    expect(scoreLead(buildLead(), events, NOW)).toMatchObject({ score: 30, scoreBand: 'WARM' });
  });

  it('7 × VIEW_CAR → 70 → WARM (biên trên)', () => {
    const events = Array.from({ length: 7 }, () => event('VIEW_CAR', { carId: carX }));
    expect(scoreLead(buildLead(), events, NOW)).toMatchObject({ score: 70, scoreBand: 'WARM' });
  });

  it('20 × VIEW_CAR → cap 100 → HOT', () => {
    const events = Array.from({ length: 20 }, () => event('VIEW_CAR', { carId: carX }));
    expect(scoreLead(buildLead(), events, NOW)).toMatchObject({ score: 100, scoreBand: 'HOT' });
  });

  it('event cũ 31 ngày không tính', () => {
    const events = [event('VIEW_CAR', { carId: carX, occurredAt: daysAgo(31) })];
    expect(scoreLead(buildLead(), events, NOW)).toMatchObject({ score: 0, scoreBand: 'COLD' });
  });

  it('event xe Y khi lead gắn xe X → 0', () => {
    const carY = new mongoose.Types.ObjectId();
    const events = [event('VIEW_CAR', { carId: carY })];
    expect(scoreLead(buildLead(), events, NOW).score).toBe(0);
  });

  it('idempotent: chạy 2 lần cùng (events, now) cho cùng kết quả', () => {
    const events = [
      event('VIEW_CAR', { carId: carX, occurredAt: daysAgo(3) }),
      event('WISHLIST_ADD', { carId: carX, occurredAt: daysAgo(10) }),
    ];
    const first = scoreLead(buildLead(), events, NOW);
    const second = scoreLead(buildLead(), events, NOW);
    expect(second).toEqual(first);
  });

  it('lastInteractionAt là thời điểm event mới nhất được tính', () => {
    const events = [
      event('VIEW_CAR', { carId: carX, occurredAt: daysAgo(5) }),
      event('VIEW_CAR', { carId: carX, occurredAt: daysAgo(2) }),
    ];
    const result = scoreLead(buildLead(), events, NOW);
    expect(result.lastInteractionAt).toEqual(daysAgo(2));
  });
});
