/**
 * @file analytics-schema.test.js
 * @description KAN-100 — tests for the Joi validator of GET /manage/analytics/overview.
 * These only exercise the validator in isolation; no HTTP/DB.
 */

import { analyticsOverviewQuery } from '../src/routes/analyticsSchemas.js';

const validate = (input) => analyticsOverviewQuery.validate(input, { convert: true });

describe('analyticsOverviewQuery', () => {
  test('both fields omitted → default 180-day window ending now', () => {
    const { error, value } = validate({});
    expect(error).toBeUndefined();
    expect(value.from).toBeInstanceOf(Date);
    expect(value.to).toBeInstanceOf(Date);
    const spanDays = (value.to - value.from) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBeGreaterThan(179.9);
    expect(spanDays).toBeLessThan(180.1);
  });

  test('from and to accepted as ISO strings', () => {
    const { error, value } = validate({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-01T00:00:00Z',
    });
    expect(error).toBeUndefined();
    expect(value.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(value.to.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  test('inverted range → error', () => {
    const { error } = validate({ from: '2026-05-01', to: '2026-04-01' });
    expect(error).toBeDefined();
    expect(error.message).toMatch(/earlier/i);
  });

  test('range > 365 days → error', () => {
    const { error } = validate({ from: '2024-01-01', to: '2026-01-02' });
    expect(error).toBeDefined();
    expect(error.message).toMatch(/365/);
  });

  test('range exactly 365 days is accepted', () => {
    const { error } = validate({ from: '2025-01-01', to: '2026-01-01' });
    expect(error).toBeUndefined();
  });

  test('non-date strings are rejected by the ISO date rule', () => {
    const { error } = validate({ from: 'not-a-date', to: '2026-01-01' });
    expect(error).toBeDefined();
  });
});
