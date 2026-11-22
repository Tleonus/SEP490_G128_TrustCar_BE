/**
 * @file analytics-service.test.js
 * @description KAN-100 — tests for the admin analytics overview service.
 *
 * Models are mocked with `jest.unstable_mockModule` so no MongoDB connection is
 * needed. We assert:
 *   - salesByMonth is padded to 6 slots even when no sales exist
 *   - the funnel reports the correct conversion rates
 *   - topCars joins through the fake `$lookup` output
 *   - avgDaysInStock is null when no completed sales exist
 *   - the 60-second cache is bypassed in NODE_ENV=test
 */

import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';

// Each model exports `default` with the methods the service calls. We return
// jest.fn()s so individual tests can tailor the response.
const mockSaleRecord = { aggregate: jest.fn(), countDocuments: jest.fn() };
const mockLead = { countDocuments: jest.fn() };
const mockAppointment = { countDocuments: jest.fn() };
const mockCar = {};
const mockVisitorSession = { countDocuments: jest.fn() };

jest.unstable_mockModule('../src/models/sale-record.model.js', () => ({ default: mockSaleRecord }));
jest.unstable_mockModule('../src/models/Lead.js', () => ({ default: mockLead }));
jest.unstable_mockModule('../src/models/Appointment.js', () => ({ default: mockAppointment }));
jest.unstable_mockModule('../src/models/Car.js', () => ({ default: mockCar }));
jest.unstable_mockModule('../src/models/visitor-session.model.js', () => ({ default: mockVisitorSession }));

const svc = await import('../src/services/analyticsService.js');

const FROM = new Date('2026-05-01T00:00:00Z');
const TO = new Date('2026-11-01T00:00:00Z');

beforeEach(() => {
  mockSaleRecord.aggregate.mockReset();
  mockSaleRecord.countDocuments.mockReset();
  mockLead.countDocuments.mockReset();
  mockAppointment.countDocuments.mockReset();
  mockVisitorSession.countDocuments.mockReset();
  svc.__clearAnalyticsCacheForTests();
});

describe('getOverview — empty DB', () => {
  beforeEach(() => {
    mockSaleRecord.aggregate.mockResolvedValue([]);
    mockSaleRecord.countDocuments.mockResolvedValue(0);
    mockLead.countDocuments.mockResolvedValue(0);
    mockAppointment.countDocuments.mockResolvedValue(0);
    mockVisitorSession.countDocuments.mockResolvedValue(0);
  });

  test('salesByMonth is padded to exactly 6 slots of zeroes', async () => {
    const res = await svc.getOverview({ from: FROM, to: TO });
    expect(res.salesByMonth).toHaveLength(6);
    expect(res.salesByMonth.every((s) => s.count === 0 && s.revenue === 0)).toBe(true);
    expect(res.salesByMonth[5].month).toBe('2026-11');
  });

  test('funnel reports all zeros and 0% conversion rates', async () => {
    const res = await svc.getOverview({ from: FROM, to: TO });
    expect(res.leadsFunnel).toEqual({
      visitors: 0, leads: 0, appointments: 0, sales: 0,
      conversionRates: { leadRate: 0, apptRate: 0, saleRate: 0 },
    });
  });

  test('avgDaysInStock returns null when no completed sales join', async () => {
    const res = await svc.getOverview({ from: FROM, to: TO });
    expect(res.avgDaysInStock).toBeNull();
  });

  test('topCars and revenueByStaff are empty arrays', async () => {
    const res = await svc.getOverview({ from: FROM, to: TO });
    expect(res.topCars).toEqual([]);
    expect(res.revenueByStaff).toEqual([]);
  });
});

describe('getOverview — populated', () => {
  beforeEach(() => {
    // salesByMonth aggregate: 12 sales spread over two months.
    // topCars aggregate:      2 cars
    // avgDays aggregate:      one row, 42.5 days
    // revenueByStaff:         one row
    mockSaleRecord.aggregate
      // call 1: salesByMonth
      .mockResolvedValueOnce([
        { _id: { y: 2026, m: 10 }, count: 7, revenue: 4_900_000_000 },
        { _id: { y: 2026, m: 11 }, count: 5, revenue: 3_500_000_000 },
      ])
      // call 2: topCars
      .mockResolvedValueOnce([
        { carId: 'c1', count: 4, revenue: 2_800_000_000, make: 'Toyota', model: 'Camry', year: 2020, vehicleCode: 'TC-24-001' },
        { carId: 'c2', count: 3, revenue: 2_100_000_000, make: 'Honda', model: 'CR-V', year: 2021, vehicleCode: 'TC-24-002' },
      ])
      // call 3: avgDaysInStock
      .mockResolvedValueOnce([{ _id: null, avgDays: 42.5, samples: 12 }])
      // call 4: revenueByStaff
      .mockResolvedValueOnce([
        { userId: 'u1', deals: 8, revenue: 5_600_000_000, fullName: 'Nguyễn Văn A', email: 'a@trustcar.vn' },
      ]);

    mockSaleRecord.countDocuments.mockResolvedValue(12);
    mockLead.countDocuments.mockResolvedValue(30);
    mockAppointment.countDocuments.mockResolvedValue(18);
    mockVisitorSession.countDocuments.mockResolvedValue(600);
  });

  test('funnel computes conversion rates in percent to 1 decimal', async () => {
    const res = await svc.getOverview({ from: FROM, to: TO });
    expect(res.leadsFunnel).toEqual({
      visitors: 600, leads: 30, appointments: 18, sales: 12,
      conversionRates: { leadRate: 5.0, apptRate: 60.0, saleRate: 66.7 },
    });
  });

  test('salesByMonth fills missing months with zeroes', async () => {
    const res = await svc.getOverview({ from: FROM, to: TO });
    const oct = res.salesByMonth.find((s) => s.month === '2026-10');
    const nov = res.salesByMonth.find((s) => s.month === '2026-11');
    const sep = res.salesByMonth.find((s) => s.month === '2026-09');
    expect(oct).toEqual({ month: '2026-10', count: 7, revenue: 4_900_000_000 });
    expect(nov).toEqual({ month: '2026-11', count: 5, revenue: 3_500_000_000 });
    expect(sep).toEqual({ month: '2026-09', count: 0, revenue: 0 });
  });

  test('topCars produces a title from make/model/year', async () => {
    const res = await svc.getOverview({ from: FROM, to: TO });
    expect(res.topCars[0]).toMatchObject({
      title: 'Toyota Camry 2020',
      vehicleCode: 'TC-24-001',
      count: 4,
      revenue: 2_800_000_000,
    });
  });

  test('avgDaysInStock returns the rounded mean from the aggregate', async () => {
    const res = await svc.getOverview({ from: FROM, to: TO });
    expect(res.avgDaysInStock).toBe(42.5);
  });

  test('revenueByStaff passes through the joined user document', async () => {
    const res = await svc.getOverview({ from: FROM, to: TO });
    expect(res.revenueByStaff).toHaveLength(1);
    expect(res.revenueByStaff[0]).toMatchObject({
      userId: 'u1', deals: 8, revenue: 5_600_000_000, fullName: 'Nguyễn Văn A',
    });
  });
});

describe('cache', () => {
  test('is bypassed in test environment so each call re-queries the models', async () => {
    mockSaleRecord.aggregate.mockResolvedValue([]);
    mockSaleRecord.countDocuments.mockResolvedValue(0);
    mockLead.countDocuments.mockResolvedValue(0);
    mockAppointment.countDocuments.mockResolvedValue(0);
    mockVisitorSession.countDocuments.mockResolvedValue(0);

    await svc.getOverview({ from: FROM, to: TO });
    await svc.getOverview({ from: FROM, to: TO });

    // 4 aggregate calls per overview (salesByMonth, topCars, avgDays, revenueByStaff)
    expect(mockSaleRecord.aggregate).toHaveBeenCalledTimes(8);
    // 1 countDocuments per model, per overview
    expect(mockVisitorSession.countDocuments).toHaveBeenCalledTimes(2);
  });
});
