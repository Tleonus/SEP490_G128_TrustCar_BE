/**
 * @file cpoCertificatePdf.js
 * @description Renders the public CPO inspection report (SPEC KAN-15 §5, built by
 * inspectionReportMapper) as a single-page A4 certificate with a QR code.
 *
 * No PDF or QR dependency: the page is drawn with miniPdf (built-in Helvetica,
 * WinAnsi) and the QR matrix comes from qrMatrix. Vietnamese tone marks have no
 * WinAnsi code point, so miniPdf transliterates them to the base letter — the
 * certificate stays readable without embedding a font file.
 *
 * The QR points at the public car page (`{FRONTEND_URL}/xe/{idOrCode}`), the same
 * target the front-end QR uses, so scanning it opens the live certificate.
 */

import { createPdf, textWidth, wrapText } from '../utils/miniPdf.js';
import { makeQrMatrix } from '../utils/qrMatrix.js';
import { ReportLevel } from './inspectionReportMapper.js';

const NAVY = [0.07, 0.16, 0.34];
const GOLD = [0.72, 0.56, 0.2];
const GREEN = [0.13, 0.55, 0.13];
const RED = [0.7, 0.13, 0.13];
const INK = [0.13, 0.15, 0.18];
const MUTED = [0.4, 0.43, 0.48];
const LINE = [0.82, 0.84, 0.86];
const LIGHT = [0.95, 0.96, 0.97];

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;

const FRONTEND_URL = () => (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');

/** Public page the certificate QR opens. Mirrors the front-end `buildPublicCarUrl`. */
export const certificateQrTarget = (idOrCode) => `${FRONTEND_URL()}/xe/${encodeURIComponent(idOrCode)}`;

const formatDate = (iso) => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
};

const formatNumber = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : null);

/** Draws the QR matrix as filled squares inside a frame. */
const drawQr = (pdf, matrix, x, y, moduleSize) => {
  const { size } = matrix;
  const quiet = moduleSize;
  const side = (size + 2) * moduleSize;
  pdf.rect(x, y, side, side, [1, 1, 1]);
  pdf.strokeRect(x, y, side, side, LINE, 0.6);
  matrix.modules.forEach((row, r) => row.forEach((dark, c) => {
    if (dark) pdf.rect(x + quiet + c * moduleSize, y + side - quiet - (r + 1) * moduleSize, moduleSize, moduleSize, [0, 0, 0]);
  }));
  return side;
};

/**
 * @param {object} report - public inspection report from `buildPublicReport`
 * @param {{ idOrCode: string }} context - the car id or vehicleCode the QR points at
 * @returns {Buffer} PDF bytes
 */
export const renderCertificatePdf = (report, { idOrCode }) => {
  const pdf = createPdf({ width: PAGE_W, height: PAGE_H });
  const vehicle = report.vehicle || {};

  // Header band.
  pdf.rect(0, PAGE_H - 78, PAGE_W, 78, NAVY);
  pdf.rect(0, PAGE_H - 82, PAGE_W, 4, GOLD);
  pdf.text('TRUSTCAR', MARGIN, PAGE_H - 38, { fontSize: 20, bold: true, color: [1, 1, 1] });
  pdf.text('CERTIFIED PRE-OWNED', MARGIN, PAGE_H - 58, { fontSize: 9, color: GOLD });
  pdf.text('CHUNG NHAN KIEM DINH', PAGE_W - MARGIN, PAGE_H - 46, { fontSize: 11, bold: true, color: [1, 1, 1], align: 'right' });

  // Certificate identity.
  let y = PAGE_H - 112;
  pdf.text(`So chung nhan: ${report.certificateId || '-'}`, MARGIN, y, { fontSize: 12, bold: true, color: NAVY });
  pdf.text(`Ngay cap: ${formatDate(report.issuedAt)}`, PAGE_W - MARGIN, y, { fontSize: 10, color: MUTED, align: 'right' });

  // Vehicle block.
  y -= 30;
  pdf.rect(MARGIN, y - 62, CONTENT_W, 78, LIGHT);
  const title = [vehicle.make, vehicle.model, vehicle.variant].filter(Boolean).join(' ') || 'Khong ro';
  pdf.text(title, MARGIN + 14, y, { fontSize: 15, bold: true, color: INK });
  const facts = [
    ['Nam san xuat', vehicle.year],
    ['Mau', vehicle.color],
    ['So km', formatNumber(vehicle.mileage) ? `${formatNumber(vehicle.mileage)} km` : null],
  ].filter(([, value]) => value != null);
  facts.forEach(([label, value], i) => {
    const col = MARGIN + 14 + (i % 3) * 170;
    pdf.text(label, col, y - 24, { fontSize: 8, color: MUTED });
    pdf.text(String(value), col, y - 38, { fontSize: 11, bold: true, color: INK });
  });

  // Criteria table.
  y -= 96;
  pdf.text('KET QUA 5 NHOM TIEU CHI', MARGIN, y, { fontSize: 10, bold: true, color: NAVY });
  y -= 8;
  pdf.line(MARGIN, y, PAGE_W - MARGIN, y, GOLD, 1);
  y -= 20;

  const groups = report.groups || [];
  groups.forEach((group, index) => {
    const rowH = 26;
    if (index % 2 === 0) pdf.rect(MARGIN, y - 7, CONTENT_W, rowH, LIGHT);
    pdf.text(String(index + 1).padStart(2, '0'), MARGIN + 10, y, { fontSize: 10, bold: true, color: GOLD });
    pdf.text(group.label || group.key, MARGIN + 36, y, { fontSize: 10, color: INK });
    const verdict = group.passed ? 'DAT' : 'KHONG DAT';
    pdf.text(verdict, PAGE_W - MARGIN - 12, y, { fontSize: 10, bold: true, color: group.passed ? GREEN : RED, align: 'right' });
    y -= rowH;
  });

  // Minor defects, FULL reports only.
  if (report.level === ReportLevel.FULL) {
    const defects = groups.flatMap((g) => (g.minorDefects || []).map((d) => ({ group: g.label, ...d })));
    y -= 12;
    pdf.text('KHUYET DIEM NHO', MARGIN, y, { fontSize: 10, bold: true, color: NAVY });
    y -= 16;
    if (!defects.length) {
      pdf.text('Khong ghi nhan khuyet diem nho.', MARGIN, y, { fontSize: 9, color: MUTED });
      y -= 16;
    } else {
      defects.slice(0, 6).forEach((d) => {
        const line = `- ${d.label}${d.location ? ` (${d.location})` : ''}`;
        pdf.text(line, MARGIN, y, { fontSize: 9, color: INK });
        y -= 14;
      });
    }
  }

  // Scope note.
  y -= 8;
  wrapText(report.scopeNote || '', 8, CONTENT_W).forEach((line) => {
    pdf.text(line, MARGIN, y, { fontSize: 8, color: MUTED });
    y -= 11;
  });

  // QR block, bottom-right.
  const target = certificateQrTarget(idOrCode);
  const matrix = makeQrMatrix(target, { ecc: 'M' });
  const qrSide = drawQr(pdf, matrix, PAGE_W - MARGIN - 150, 78, 3);
  pdf.text('Quet ma de xem chung nhan goc', PAGE_W - MARGIN - qrSide / 2, 66, { fontSize: 7, color: MUTED, align: 'center' });

  // Footer: level, inspector, disclaimer.
  pdf.line(MARGIN, 56, PAGE_W - MARGIN - qrSide - 16, 56, LINE, 0.5);
  const levelLabel = report.level === ReportLevel.FULL ? 'Bien ban day du' : 'Bien ban rut gon';
  pdf.text(levelLabel, MARGIN, 40, { fontSize: 9, bold: true, color: NAVY });
  pdf.text(`Nguoi kiem dinh: ${report.inspector || 'Khong ro'}`, MARGIN, 26, { fontSize: 8, color: MUTED });
  const disclaimer = 'Tai lieu nay duoc phat hanh tu dong. Gia tri xac thuc nam o ban goc tren he thong TrustCar.';
  if (textWidth(disclaimer, 7) < CONTENT_W) pdf.text(disclaimer, MARGIN, 12, { fontSize: 7, color: MUTED });

  return pdf.toBuffer();
};

export default { renderCertificatePdf, certificateQrTarget };
