/**
 * @file cpo-certificate-pdf.test.js
 * @description KAN-20 — CPO certificate PDF + QR.
 * Integration: GET /api/v1/public/cars/:id/cpo-certificate.pdf returns a real PDF.
 * Unit: the dependency-free QR generator and the certificate renderer.
 */

import request from 'supertest';
import { readFileSync } from 'node:fs';
import { setupInspectionHarness } from './helpers/fakeInspectionModels.js';
import { getChecklist } from '../src/config/inspectionChecklist.js';
import { makeQrMatrix } from '../src/utils/qrMatrix.js';
import { renderCertificatePdf, certificateQrTarget } from '../src/services/cpoCertificatePdf.js';

const h = await setupInspectionHarness();
const api = () => request(h.app);
const CODE = 'CPO-20261102-3F9A';
const allTrue = {
  noMajorAccident: true, noWaterDamage: true, engineGearboxIntact: true, verifiedOdo: true, electricalSystemPassed: true,
};
const pdfOf = (idOrCode) => api().get(`/api/v1/public/cars/${idOrCode}/cpo-certificate.pdf`);

let inspector;

const certifiedCar = (carOverrides = {}, recordOverrides = {}) => {
  const carId = h.createCar({ status: 'AVAILABLE', cpoCertificateId: CODE, mileage: 40000, ...carOverrides });
  h.insertRecord({
    carId,
    status: 'SUBMITTED',
    source: 'STAFF',
    checklistVersion: '1.0',
    result: 'PASSED',
    cpoCertificateId: CODE,
    criteria: allTrue,
    odo: 50000,
    inspectorId: inspector.id,
    submittedBy: inspector.id,
    submittedAt: new Date('2026-11-02T08:15:00Z'),
    vehicleInfo: {
      original: { make: 'TOYOTA', mileage: 40000 },
      confirmed: { make: 'TOYOTA', model: 'Vios', variant: '1.5G', color: 'Trắng', year: 2020, mileage: 50000 },
    },
    groups: getChecklist().map((def) => ({
      groupKey: def.key,
      note: 'nội bộ',
      passed: true,
      items: def.items.map((i) => ({ itemKey: i.key, result: 'PASS', note: '', photos: [] })),
      photos: [],
      minorDefects: [],
    })),
    ...recordOverrides,
  });
  return carId;
};

beforeEach(async () => {
  h.reset();
  const { id } = await h.createUser({ roleName: 'SALES_STAFF', fullName: 'Nguyễn Văn An' });
  inspector = { id };
});

describe('GET /api/v1/public/cars/:id/cpo-certificate.pdf', () => {
  test('certified car → 200 application/pdf, no token needed', async () => {
    const carId = certifiedCar();

    const res = await pdfOf(carId);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['content-disposition']).toContain(`chung-nhan-${CODE}.pdf`);
    expect(res.headers['content-disposition']).toContain('inline');
    const body = res.body.toString('latin1');
    expect(body.startsWith('%PDF-1.4')).toBe(true);
    expect(body.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(res.body.length).toBeGreaterThan(2000);
  });

  test('lookup by vehicleCode works', async () => {
    certifiedCar({ vehicleCode: 'TC-2026-0042' });

    const res = await pdfOf('TC-2026-0042');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
  });

  test.each([
    ['REJECTED car', { status: 'REJECTED' }, {}],
    ['inactive car', { isActive: false }, {}],
    ['car without certificate', { cpoCertificateId: null }, {}],
    ['record not PASSED', {}, { result: 'FAILED' }],
  ])('%s → 404 INSPECTION_REPORT_NOT_FOUND (JSON, not PDF)', async (_label, carOverrides, recordOverrides) => {
    const carId = certifiedCar(carOverrides, recordOverrides);

    const res = await pdfOf(carId);

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.code).toBe('INSPECTION_REPORT_NOT_FOUND');
  });

  test('unknown id and garbage id → the same 404', async () => {
    for (const id of ['65f000000000000000000099', 'abc$ne']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await pdfOf(id);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('INSPECTION_REPORT_NOT_FOUND');
    }
  });
});

describe('makeQrMatrix', () => {
  test('short text → version 1, 21×21, deterministic', () => {
    const a = makeQrMatrix('A');
    const b = makeQrMatrix('A');

    expect(a.version).toBe(1);
    expect(a.size).toBe(21);
    expect(a.modules).toHaveLength(21);
    expect(a.modules[0]).toHaveLength(21);
    expect(a.modules).toEqual(b.modules);
    expect(a.mask).toBe(b.mask);
  });

  test('a car URL fits a small version and grows with content', () => {
    const short = makeQrMatrix('https://trustcar.vn/xe/TC-2026-0042');
    const long = makeQrMatrix(`https://trustcar.vn/xe/${'x'.repeat(120)}`);

    expect(short.version).toBeLessThanOrEqual(4);
    expect(long.version).toBeGreaterThan(short.version);
    expect(long.size).toBe(17 + long.version * 4);
  });

  test('finder patterns are in the three corners', () => {
    const { modules, size } = makeQrMatrix('https://trustcar.vn/xe/TC-2026-0042');
    const finderAt = (r, c) => modules[r][c] === 1 && modules[r + 1][c + 1] === 0 && modules[r + 6][c + 6] === 1;

    expect(finderAt(0, 0)).toBe(true);
    expect(finderAt(0, size - 7)).toBe(true);
    expect(finderAt(size - 7, 0)).toBe(true);
  });

  test('every ECC level produces a valid square matrix', () => {
    for (const ecc of ['L', 'M', 'Q', 'H']) {
      const m = makeQrMatrix('https://trustcar.vn/xe/TC-2026-0042', { ecc });
      expect(m.ecc).toBe(ecc);
      expect(m.modules).toHaveLength(m.size);
      expect(m.modules.every((row) => row.length === m.size)).toBe(true);
    }
  });

  test('rejects unknown ECC and oversized content', () => {
    expect(() => makeQrMatrix('x', { ecc: 'Z' })).toThrow(/error-correction/);
    expect(() => makeQrMatrix('x'.repeat(2000))).toThrow(/capacity/);
  });

  // The full matrix is verified against the `qrcode` npm package; these are the
  // captured bytes so a change to masking, format info or alignment regresses here.
  const golden = JSON.parse(readFileSync(new URL('./fixtures/qr-golden.json', import.meta.url), 'utf8'));
  test.each(golden.map((g) => [g.text, g.ecc, g.version, g.mask, g.rows]))(
    'golden vector: %s (%s)', (text, ecc, version, mask, rows) => {
      const m = makeQrMatrix(text, { ecc });

      expect(m.version).toBe(version);
      expect(m.mask).toBe(mask);
      const actual = m.modules.map((row) => {
        let s = '';
        for (let c = 0; c < m.size; c += 4) {
          let n = 0;
          for (let k = 0; k < 4; k += 1) n = (n << 1) | (row[c + k] || 0);
          s += n.toString(16);
        }
        return s;
      });
      expect(actual).toEqual(rows);
    },
  );
});

describe('renderCertificatePdf', () => {
  const report = {
    certificateId: CODE,
    level: 'FULL',
    issuedAt: '2026-11-02T08:15:00.000Z',
    inspector: 'N.V.A.',
    scopeNote: 'Bao cao pham vi kiem dinh.',
    vehicle: { make: 'TOYOTA', model: 'Vios', variant: '1.5G', year: 2020, color: 'Trắng', mileage: 50000 },
    groups: getChecklist().map((def) => ({ key: def.key, label: def.label, passed: true, minorDefects: [] })),
  };

  test('QR target mirrors the front-end public car URL', () => {
    expect(certificateQrTarget('TC-2026-0042')).toMatch(/\/xe\/TC-2026-0042$/);
    expect(certificateQrTarget('a b')).toContain('/xe/a%20b');
  });

  test('produces a well-formed PDF buffer', () => {
    const buf = renderCertificatePdf(report, { idOrCode: 'TC-2026-0042' });
    const text = buf.toString('latin1');

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Page');
    expect(text).toContain('Helvetica');
    expect(text).toContain('startxref');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  test('MINIMAL report renders without the defects section', () => {
    const minimal = { ...report, level: 'MINIMAL', groups: [] };
    const buf = renderCertificatePdf(minimal, { idOrCode: 'TC-2026-0042' });

    expect(buf.toString('latin1').startsWith('%PDF-1.4')).toBe(true);
  });
});
