/**
 * @file vehicle-history-pdf.test.js
 * @description KAN-98 — vehicle history PDF renderer.
 */

import { renderVehicleHistoryPdf } from '../src/services/vehicleHistoryPdf.js';

const HASH = 'a'.repeat(24);

const report = (overrides = {}) => ({
  verifyHash: HASH,
  verifyUrl: `https://trustcar.vn/verify/${HASH}`,
  generatedAt: '2026-12-08T00:00:00.000Z',
  certificate: { id: 'CPO-20261201-A1B2', issuedAt: '2026-12-01T08:00:00.000Z', inspectorInitials: 'N.V.A.', level: 'FULL' },
  vehicle: { vehicleCode: 'TC-2026-0042', make: 'VINFAST', model: 'VF 8', variant: 'Plus', color: 'Trang', year: 2023, currentMileage: 44950 },
  ownership: { previousOwnersCount: 2, registrationDate: '2019-03-14T00:00:00.000Z', ownerType: 'INDIVIDUAL', intakeAt: '2026-10-02T00:00:00.000Z', daysInStock: 64 },
  odometerHistory: {
    items: [
      { at: '2026-06-10T00:00:00.000Z', value: 41200, source: 'INSPECTION' },
      { at: '2026-10-02T00:00:00.000Z', value: 44890, source: 'INTAKE' },
      { at: '2026-12-01T00:00:00.000Z', value: 44950, source: 'INSPECTION' },
    ],
    insufficientData: false,
  },
  priceHistory: { items: [{ at: '2026-11-01T00:00:00.000Z', oldPrice: 1000000000, newPrice: 950000000, dropAmount: 50000000, reason: null }], truncated: false },
  maintenance: [{ at: '2026-10-14T00:00:00.000Z', kind: 'WORKSHOP', description: 'Vao bao duong', provider: null, odometer: null }],
  inspections: [{ at: '2026-12-01T08:00:00.000Z', result: 'PASSED', certificateId: 'CPO-20261201-A1B2', inspectorInitials: 'N.V.A.' }],
  criteria: [
    { key: 'body', label: 'Than vo', passed: true },
    { key: 'engine', label: 'Dong co', passed: true },
  ],
  minorDefects: [{ label: 'Tray son', location: 'Canh trai', description: 'Nho' }],
  scopeNote: 'Bao cao pham vi kiem dinh.',
  ...overrides,
});

const textOf = (buf) => buf.toString('latin1');

describe('renderVehicleHistoryPdf', () => {
  test('T24 — full report is a well-formed multi-page PDF', () => {
    const text = textOf(renderVehicleHistoryPdf(report()));
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Count 3');
    expect(text).toContain('startxref');
  });

  test('T25 — sparse report (no maintenance, one odo point) still renders', () => {
    const sparse = report({
      maintenance: [],
      odometerHistory: { items: [{ at: '2026-10-02T00:00:00.000Z', value: 44950, source: 'INTAKE' }], insufficientData: true },
      priceHistory: { items: [], truncated: false },
      inspections: [],
      minorDefects: [],
    });
    const text = textOf(renderVehicleHistoryPdf(sparse));
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toMatch(/\/Count [23]/);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  test('T26 — long history overflows onto extra pages, none of them empty', () => {
    const long = report({
      priceHistory: {
        items: Array.from({ length: 20 }, (_, i) => ({
          at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
          oldPrice: 1000000000, newPrice: 990000000, dropAmount: 10000000, reason: null,
        })),
        truncated: true,
      },
      inspections: Array.from({ length: 12 }, (_, i) => ({
        at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
        result: 'PASSED', certificateId: `CPO-${i}`, inspectorInitials: 'N.V.A.',
      })),
    });
    const text = textOf(renderVehicleHistoryPdf(long));
    const count = Number(text.match(/\/Count (\d+)/)[1]);
    expect(count).toBeGreaterThanOrEqual(3);
    const streams = [...text.matchAll(/stream\n([\s\S]*?)endstream/g)].map((m) => m[1].trim());
    expect(streams).toHaveLength(count);
    streams.forEach((stream) => expect(stream.length).toBeGreaterThan(0));
  });

  test('T27 — the PDF embeds the verify hash and the verify URL', () => {
    const text = textOf(renderVehicleHistoryPdf(report()));
    expect(text).toContain(HASH);
    expect(text).toContain('/verify/');
  });
});
