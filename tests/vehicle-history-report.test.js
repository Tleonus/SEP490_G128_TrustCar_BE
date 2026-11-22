/**
 * @file vehicle-history-report.test.js
 * @description KAN-98 — pure builder for the Vehicle History Report.
 * No database, no network: feeds plain objects into buildVehicleHistoryReport
 * and asserts the allow-listed shape and the merge rules.
 */

import { buildVehicleHistoryReport } from '../src/services/vehicleHistoryReport.js';

const CAR_ID = '65f000000000000000000001';
const baseCar = (overrides = {}) => ({
  _id: CAR_ID,
  vehicleCode: 'TC-2026-0042',
  make: 'VINFAST',
  model: 'VF 8',
  variant: 'Plus',
  year: 2023,
  fuelType: 'ELECTRIC',
  transmission: 'AUTOMATIC',
  mileage: 44950,
  specifications: { color: 'Trang' },
  ownerType: 'INDIVIDUAL',
  previousOwnersCount: 2,
  registrationDate: new Date('2019-03-14T00:00:00Z'),
  cpoCertificateId: 'CPO-20261201-A1B2',
  createdAt: new Date('2026-10-02T00:00:00Z'),
  listedDate: new Date('2026-10-05T00:00:00Z'),
  priceHistory: [],
  serviceHistory: [],
  // Sensitive fields that must NEVER leak into the report.
  vin: 'RLLV1234567890123',
  licensePlate: '30A-12345',
  floorPrice: 900000000,
  originalPrice: 1100000000,
  internalNotes: 'secret',
  ...overrides,
});

const certRecord = {
  certificateId: 'CPO-20261201-A1B2',
  issuedAt: '2026-12-01T08:00:00.000Z',
  level: 'FULL',
  inspector: 'N.V.A.',
  scopeNote: 'Bao cao pham vi.',
  vehicle: { make: 'VINFAST', model: 'VF 8', variant: 'Plus', color: 'Trang', year: 2023, mileage: 44950 },
  groups: [
    { key: 'body', label: 'Than vo', passed: true, minorDefects: [{ label: 'Tray son', location: 'Canh trai', description: 'Nho' }] },
    { key: 'engine', label: 'Dong co', passed: true, minorDefects: [] },
  ],
};

const call = (overrides = {}) => buildVehicleHistoryReport({
  car: baseCar(),
  certRecord,
  inspectionRecords: [],
  maintenanceSessions: [],
  inspectorNames: {},
  verifyHash: 'a'.repeat(24),
  verifyUrl: 'https://trustcar.vn/verify/' + 'a'.repeat(24),
  generatedAt: '2026-12-08T00:00:00.000Z',
  ...overrides,
});

describe('buildVehicleHistoryReport', () => {
  test('T1 — merges inspections, price changes, declared + workshop maintenance', () => {
    const report = call({
      inspectionRecords: [
        { submittedAt: new Date('2026-06-10T00:00:00Z'), odo: 41200, result: 'PASSED', cpoCertificateId: 'CPO-OLD', submittedBy: 'u1' },
        { submittedAt: new Date('2026-12-01T08:00:00Z'), odo: 44950, result: 'PASSED', cpoCertificateId: 'CPO-20261201-A1B2', submittedBy: 'u2' },
      ],
      inspectorNames: { u1: 'Nguyen Van An', u2: 'Tran Thi B' },
      maintenanceSessions: [
        { createdAt: new Date('2026-10-14T00:00:00Z'), changes: { after: { status: 'MAINTENANCE' } }, summary: 'Vao bao duong truoc ban' },
      ],
      car: baseCar({
        serviceHistory: [
          { performedAt: new Date('2025-08-02T00:00:00Z'), description: 'Thay dau, loc gio', provider: 'Hang', odometer: 38000 },
        ],
        priceHistory: [
          { price: 1000000000, changedAt: new Date('2026-10-02T00:00:00Z') },
          { price: 950000000, changedAt: new Date('2026-11-01T00:00:00Z'), reason: 'Giam gia' },
          { price: 900000000, changedAt: new Date('2026-12-01T00:00:00Z') },
        ],
      }),
    });

    expect(report.maintenance).toHaveLength(2);
    // Newest first.
    expect(report.maintenance[0].kind).toBe('WORKSHOP');
    expect(report.maintenance[1].kind).toBe('DECLARED');
    expect(report.maintenance[1].odometer).toBe(38000);

    expect(report.priceHistory.items).toHaveLength(2);
    expect(report.priceHistory.items[0].newPrice).toBe(900000000);
    expect(report.priceHistory.truncated).toBe(false);

    expect(report.inspections).toHaveLength(2);
    expect(report.inspections[0].inspectorInitials).toBe('T.T.B.');
    expect(report.certificate.id).toBe('CPO-20261201-A1B2');
    expect(report.criteria).toHaveLength(2);
    expect(report.minorDefects).toHaveLength(1);
    expect(report.ownership.previousOwnersCount).toBe(2);
    expect(report.ownership.daysInStock).toBe(64);
  });

  test('T2 — no sensitive fields leak into the JSON output', () => {
    const json = JSON.stringify(call());
    ['RLLV1234567890123', '30A-12345', '900000000', '1100000000', 'secret', 'floorPrice', 'licensePlate', 'internalNotes'].forEach((needle) => {
      expect(json).not.toContain(needle);
    });
  });

  test('T3 — ODO merges 2 inspections + intake mileage, sorted ascending, deduped', () => {
    const report = call({
      inspectionRecords: [
        { submittedAt: new Date('2026-12-01T00:00:00Z'), odo: 44950 },
        { submittedAt: new Date('2026-06-10T00:00:00Z'), odo: 41200 },
        // Duplicate day+value must be dropped.
        { submittedAt: new Date('2026-06-10T12:00:00Z'), odo: 41200 },
      ],
    });
    const values = report.odometerHistory.items.map((p) => p.value);
    expect(values).toEqual([41200, 44950, 44950].filter((v, i, a) => a.indexOf(v) === i).concat([44950]).slice(0, 3));
    // 3 points, ascending, intake in the middle.
    expect(report.odometerHistory.items.map((p) => p.source)).toEqual(['INSPECTION', 'INTAKE', 'INSPECTION']);
    expect(report.odometerHistory.insufficientData).toBe(false);
  });

  test('T4 — only intake mileage → 1 point + insufficientData flag', () => {
    const report = call();
    expect(report.odometerHistory.items).toHaveLength(1);
    expect(report.odometerHistory.items[0].source).toBe('INTAKE');
    expect(report.odometerHistory.insufficientData).toBe(true);
  });

  test('T5 — priceHistory capped at 12 with truncated flag', () => {
    const priceHistory = Array.from({ length: 21 }, (_, i) => ({
      price: 1000000000 - i * 10000000,
      changedAt: new Date(Date.UTC(2026, 0, i + 1)),
    }));
    const report = call({ car: baseCar({ priceHistory }) });
    expect(report.priceHistory.items).toHaveLength(12);
    expect(report.priceHistory.truncated).toBe(true);
    // Newest first.
    expect(report.priceHistory.items[0].newPrice).toBe(800000000);
  });

  test('T6 — ActivityLog whose after.status is not MAINTENANCE is ignored', () => {
    const report = call({
      maintenanceSessions: [
        { createdAt: new Date('2026-10-14T00:00:00Z'), changes: { after: { status: 'AVAILABLE' } } },
      ],
    });
    expect(report.maintenance).toHaveLength(0);
  });

  test('T7 — missing inspector user → inspectorInitials null, no throw', () => {
    const report = call({
      inspectionRecords: [
        { submittedAt: new Date('2026-12-01T00:00:00Z'), odo: 44950, result: 'PASSED', submittedBy: 'ghost' },
      ],
    });
    expect(report.inspections[0].inspectorInitials).toBeNull();
  });
});
