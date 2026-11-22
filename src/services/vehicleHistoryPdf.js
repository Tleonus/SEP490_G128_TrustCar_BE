/**
 * @file vehicleHistoryPdf.js
 * @description Renders the KAN-98 Vehicle History Report as a 2–3 page PDF with
 * a QR verify block. Uses miniPdf's newPage() multi-page branch; shares the
 * palette with the certificate renderer but keeps hard-coded constants to
 * avoid import cycles.
 *
 * WinAnsi only — Vietnamese tone marks are stripped to the base letter at the
 * writer layer, so copy stays consistently unaccented (matches cpoCertificatePdf).
 */

import { createPdf, textWidth, wrapText } from '../utils/miniPdf.js';
import { makeQrMatrix } from '../utils/qrMatrix.js';

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

const formatDate = (iso) => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
};

const formatNumber = (n) =>
  (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : null);

const drawQr = (pdf, matrix, x, y, moduleSize) => {
  const { size } = matrix;
  const quiet = moduleSize;
  const side = (size + 2) * moduleSize;
  pdf.rect(x, y, side, side, [1, 1, 1]);
  pdf.strokeRect(x, y, side, side, LINE, 0.6);
  matrix.modules.forEach((row, r) => row.forEach((dark, c) => {
    if (dark) {
      pdf.rect(
        x + quiet + c * moduleSize,
        y + side - quiet - (r + 1) * moduleSize,
        moduleSize, moduleSize,
        [0, 0, 0],
      );
    }
  }));
  return side;
};

/**
 * If the cursor is about to overflow, start a new page and return a fresh y near
 * the top. The small top margin (40) leaves room for a lightweight page header.
 */
const ensureSpace = (pdf, y, needed) => {
  if (y - needed >= 70) return y;
  pdf.newPage();
  // Minimal page header: title bar + top margin.
  pdf.rect(0, PAGE_H - 36, PAGE_W, 36, NAVY);
  pdf.rect(0, PAGE_H - 40, PAGE_W, 4, GOLD);
  pdf.text('TRUSTCAR - LICH SU XE (tiep)', MARGIN, PAGE_H - 24, {
    fontSize: 11, bold: true, color: [1, 1, 1],
  });
  return PAGE_H - 60;
};

const drawPageOneHeader = (pdf, cert) => {
  pdf.rect(0, PAGE_H - 78, PAGE_W, 78, NAVY);
  pdf.rect(0, PAGE_H - 82, PAGE_W, 4, GOLD);
  pdf.text('TRUSTCAR', MARGIN, PAGE_H - 38, { fontSize: 20, bold: true, color: [1, 1, 1] });
  pdf.text('BAO CAO LICH SU XE', MARGIN, PAGE_H - 58, { fontSize: 9, color: GOLD });
  pdf.text('VEHICLE HISTORY REPORT', PAGE_W - MARGIN, PAGE_H - 46, {
    fontSize: 11, bold: true, color: [1, 1, 1], align: 'right',
  });

  let y = PAGE_H - 112;
  pdf.text(`So chung nhan: ${cert?.id || '-'}`, MARGIN, y, {
    fontSize: 12, bold: true, color: NAVY,
  });
  pdf.text(`Ngay cap: ${formatDate(cert?.issuedAt)}`, PAGE_W - MARGIN, y, {
    fontSize: 10, color: MUTED, align: 'right',
  });
  return y - 22;
};

const drawVehicleBlock = (pdf, vehicle, y) => {
  pdf.rect(MARGIN, y - 62, CONTENT_W, 78, LIGHT);
  const title = [vehicle.make, vehicle.model, vehicle.variant].filter(Boolean).join(' ') || 'Khong ro';
  pdf.text(title, MARGIN + 14, y, { fontSize: 15, bold: true, color: INK });
  const facts = [
    ['Nam san xuat', vehicle.year],
    ['Mau', vehicle.color],
    ['So km hien tai', formatNumber(vehicle.currentMileage) ? `${formatNumber(vehicle.currentMileage)} km` : null],
  ].filter(([, value]) => value != null);
  facts.forEach(([label, value], i) => {
    const col = MARGIN + 14 + (i % 3) * 170;
    pdf.text(label, col, y - 24, { fontSize: 8, color: MUTED });
    pdf.text(String(value), col, y - 38, { fontSize: 11, bold: true, color: INK });
  });
  return y - 80;
};

const drawCriteriaTable = (pdf, groups, startY) => {
  let y = startY;
  pdf.text('KET QUA 5 NHOM TIEU CHI', MARGIN, y, { fontSize: 10, bold: true, color: NAVY });
  y -= 8;
  pdf.line(MARGIN, y, PAGE_W - MARGIN, y, GOLD, 1);
  y -= 18;

  (groups || []).forEach((group, index) => {
    const rowH = 22;
    if (index % 2 === 0) pdf.rect(MARGIN, y - 6, CONTENT_W, rowH, LIGHT);
    pdf.text(String(index + 1).padStart(2, '0'), MARGIN + 10, y, {
      fontSize: 10, bold: true, color: GOLD,
    });
    pdf.text(group.label || group.key, MARGIN + 36, y, { fontSize: 10, color: INK });
    const verdict = group.passed ? 'DAT' : 'KHONG DAT';
    pdf.text(verdict, PAGE_W - MARGIN - 12, y, {
      fontSize: 10, bold: true, color: group.passed ? GREEN : RED, align: 'right',
    });
    y -= rowH;
  });
  return y;
};

const drawOwnershipBlock = (pdf, ownership, startY) => {
  let y = ensureSpace(pdf, startY, 110);
  pdf.text('THONG TIN SO HUU', MARGIN, y, { fontSize: 10, bold: true, color: NAVY });
  y -= 8;
  pdf.line(MARGIN, y, PAGE_W - MARGIN, y, GOLD, 1);
  y -= 18;

  const ownerLabel = ownership.ownerType === 'COMPANY' ? 'Cong ty' :
    ownership.ownerType === 'INDIVIDUAL' ? 'Ca nhan' : '-';
  const rows = [
    ['Ngay nhap kho', formatDate(ownership.intakeAt)],
    ['So chu cu (theo khai bao)', String(ownership.previousOwnersCount ?? 0)],
    ['Ngay dang ky lan dau', formatDate(ownership.registrationDate)],
    ['Loai chu so huu', ownerLabel],
    ['So ngay trong kho', ownership.daysInStock != null ? `${ownership.daysInStock} ngay` : '-'],
  ];
  rows.forEach(([label, value]) => {
    pdf.text(label, MARGIN + 10, y, { fontSize: 9, color: MUTED });
    pdf.text(String(value), PAGE_W - MARGIN - 12, y, {
      fontSize: 9, bold: true, color: INK, align: 'right',
    });
    y -= 14;
  });
  return y - 6;
};

const drawOdoHistory = (pdf, odometer, startY) => {
  let y = ensureSpace(pdf, startY, 90);
  pdf.text('LICH SU ODO', MARGIN, y, { fontSize: 10, bold: true, color: NAVY });
  y -= 8;
  pdf.line(MARGIN, y, PAGE_W - MARGIN, y, GOLD, 1);
  y -= 18;

  if (!odometer?.items?.length) {
    pdf.text('Chua co du lieu.', MARGIN + 10, y, { fontSize: 9, color: MUTED });
    return y - 16;
  }

  pdf.text('Ngay', MARGIN + 10, y, { fontSize: 8, color: MUTED });
  pdf.text('So km', MARGIN + 180, y, { fontSize: 8, color: MUTED });
  pdf.text('Nguon', MARGIN + 320, y, { fontSize: 8, color: MUTED });
  y -= 12;

  let prev = null;
  odometer.items.forEach((pt, idx) => {
    y = ensureSpace(pdf, y, 20);
    if (idx % 2 === 0) pdf.rect(MARGIN, y - 4, CONTENT_W, 14, LIGHT);
    pdf.text(formatDate(pt.at), MARGIN + 10, y, { fontSize: 9, color: INK });
    pdf.text(`${formatNumber(pt.value)} km`, MARGIN + 180, y, { fontSize: 9, color: INK });
    pdf.text(pt.source === 'INTAKE' ? 'Nhap kho' : 'Kiem dinh', MARGIN + 320, y, {
      fontSize: 9, color: INK,
    });
    y -= 14;
    if (prev && pt.value - prev.value > 0) {
      pdf.text(`+${formatNumber(pt.value - prev.value)} km`, MARGIN + 180, y, {
        fontSize: 8, color: MUTED,
      });
      y -= 12;
    }
    prev = pt;
  });

  if (odometer.insufficientData) {
    pdf.text('Chua du du lieu de doi chieu ODO.', MARGIN + 10, y, {
      fontSize: 8, color: MUTED,
    });
    y -= 12;
  }
  return y - 6;
};

const drawPriceHistory = (pdf, price, startY) => {
  let y = ensureSpace(pdf, startY, 80);
  pdf.text('LICH SU GIA', MARGIN, y, { fontSize: 10, bold: true, color: NAVY });
  y -= 8;
  pdf.line(MARGIN, y, PAGE_W - MARGIN, y, GOLD, 1);
  y -= 18;

  if (!price?.items?.length) {
    pdf.text('Chua ghi nhan thay doi gia.', MARGIN + 10, y, { fontSize: 9, color: MUTED });
    return y - 16;
  }

  pdf.text('Ngay', MARGIN + 10, y, { fontSize: 8, color: MUTED });
  pdf.text('Gia cu (VND)', MARGIN + 130, y, { fontSize: 8, color: MUTED });
  pdf.text('Gia moi (VND)', MARGIN + 260, y, { fontSize: 8, color: MUTED });
  pdf.text('Giam', MARGIN + 400, y, { fontSize: 8, color: MUTED });
  y -= 12;

  price.items.forEach((row, idx) => {
    y = ensureSpace(pdf, y, 16);
    if (idx % 2 === 0) pdf.rect(MARGIN, y - 4, CONTENT_W, 14, LIGHT);
    pdf.text(formatDate(row.at), MARGIN + 10, y, { fontSize: 9, color: INK });
    pdf.text(formatNumber(row.oldPrice) || '-', MARGIN + 130, y, { fontSize: 9, color: INK });
    pdf.text(formatNumber(row.newPrice) || '-', MARGIN + 260, y, { fontSize: 9, color: INK });
    const pct = row.oldPrice > 0
      ? `${formatNumber(row.dropAmount)} (${((row.dropAmount / row.oldPrice) * 100).toFixed(1)}%)`
      : formatNumber(row.dropAmount) || '-';
    pdf.text(pct, MARGIN + 400, y, {
      fontSize: 9, color: row.dropAmount > 0 ? GREEN : INK,
    });
    y -= 14;
  });

  if (price.truncated) {
    y = ensureSpace(pdf, y, 14);
    pdf.text('Chi hien thi 12 muc gan nhat.', MARGIN + 10, y, {
      fontSize: 8, color: MUTED,
    });
    y -= 12;
  }
  return y - 6;
};

const drawMaintenance = (pdf, maintenance, startY) => {
  let y = ensureSpace(pdf, startY, 80);
  pdf.text('BAO DUONG / SUA CHUA', MARGIN, y, { fontSize: 10, bold: true, color: NAVY });
  y -= 8;
  pdf.line(MARGIN, y, PAGE_W - MARGIN, y, GOLD, 1);
  y -= 18;

  if (!maintenance?.length) {
    pdf.text('Chua ghi nhan.', MARGIN + 10, y, { fontSize: 9, color: MUTED });
    return y - 16;
  }

  maintenance.forEach((entry) => {
    y = ensureSpace(pdf, y, 18);
    const kindLabel = entry.kind === 'WORKSHOP' ? '[Xuong TrustCar]' : '[Chu cu khai]';
    const tail = [entry.provider, entry.odometer ? `${formatNumber(entry.odometer)} km` : null]
      .filter(Boolean)
      .join(' - ');
    const line = `${formatDate(entry.at)} ${kindLabel} ${entry.description || ''}${tail ? ` - ${tail}` : ''}`;
    wrapText(line, 9, CONTENT_W - 20).forEach((ln) => {
      y = ensureSpace(pdf, y, 14);
      pdf.text(ln, MARGIN + 10, y, { fontSize: 9, color: INK });
      y -= 12;
    });
    y -= 2;
  });
  return y - 4;
};

const drawInspections = (pdf, inspections, startY) => {
  let y = ensureSpace(pdf, startY, 80);
  pdf.text('LICH SU KIEM DINH', MARGIN, y, { fontSize: 10, bold: true, color: NAVY });
  y -= 8;
  pdf.line(MARGIN, y, PAGE_W - MARGIN, y, GOLD, 1);
  y -= 18;

  if (!inspections?.length) {
    pdf.text('Chua co ban kiem dinh nao.', MARGIN + 10, y, { fontSize: 9, color: MUTED });
    return y - 16;
  }

  pdf.text('Ngay', MARGIN + 10, y, { fontSize: 8, color: MUTED });
  pdf.text('Ket qua', MARGIN + 140, y, { fontSize: 8, color: MUTED });
  pdf.text('Ma chung nhan', MARGIN + 240, y, { fontSize: 8, color: MUTED });
  pdf.text('Nguoi kiem dinh', MARGIN + 400, y, { fontSize: 8, color: MUTED });
  y -= 12;

  inspections.forEach((rec, idx) => {
    y = ensureSpace(pdf, y, 16);
    if (idx % 2 === 0) pdf.rect(MARGIN, y - 4, CONTENT_W, 14, LIGHT);
    pdf.text(formatDate(rec.at), MARGIN + 10, y, { fontSize: 9, color: INK });
    pdf.text(rec.result || '-', MARGIN + 140, y, {
      fontSize: 9, bold: true,
      color: rec.result === 'PASSED' ? GREEN : rec.result === 'FAILED' ? RED : INK,
    });
    pdf.text(rec.certificateId || '-', MARGIN + 240, y, { fontSize: 9, color: INK });
    pdf.text(rec.inspectorInitials || '-', MARGIN + 400, y, { fontSize: 9, color: INK });
    y -= 14;
  });
  return y - 4;
};

const drawMinorDefects = (pdf, defects, startY) => {
  let y = ensureSpace(pdf, startY, 60);
  pdf.text('KHUYET DIEM NHO (CHUNG NHAN GAN NHAT)', MARGIN, y, {
    fontSize: 10, bold: true, color: NAVY,
  });
  y -= 8;
  pdf.line(MARGIN, y, PAGE_W - MARGIN, y, GOLD, 1);
  y -= 16;

  if (!defects?.length) {
    pdf.text('Khong ghi nhan khuyet diem nho.', MARGIN + 10, y, {
      fontSize: 9, color: MUTED,
    });
    return y - 14;
  }

  defects.slice(0, 10).forEach((d) => {
    const line = `- ${d.label || ''}${d.location ? ` (${d.location})` : ''}${d.description ? `: ${d.description}` : ''}`;
    wrapText(line, 9, CONTENT_W - 20).forEach((ln) => {
      y = ensureSpace(pdf, y, 14);
      pdf.text(ln, MARGIN + 10, y, { fontSize: 9, color: INK });
      y -= 12;
    });
  });
  return y - 4;
};

const drawVerifyBlock = (pdf, report, startY, moduleSize = 3) => {
  let y = ensureSpace(pdf, startY, 180);
  pdf.text('XAC THUC CHUNG NHAN', MARGIN, y, { fontSize: 10, bold: true, color: NAVY });
  y -= 8;
  pdf.line(MARGIN, y, PAGE_W - MARGIN, y, GOLD, 1);
  y -= 20;

  const matrix = makeQrMatrix(report.verifyUrl || '', { ecc: 'M' });
  drawQr(pdf, matrix, MARGIN + 10, y - 140, moduleSize);

  pdf.text('Quet ma QR hoac truy cap:', MARGIN + 180, y - 10, {
    fontSize: 9, color: MUTED,
  });
  pdf.text(report.verifyUrl || '-', MARGIN + 180, y - 26, { fontSize: 9, color: INK });
  pdf.text(`Ma xac thuc: ${report.verifyHash}`, MARGIN + 180, y - 48, {
    fontSize: 9, bold: true, color: NAVY,
  });
  pdf.text('Ma QR tu dong thay doi khi xe duoc kiem dinh lai.', MARGIN + 180, y - 68, {
    fontSize: 8, color: MUTED,
  });
  return y - 150;
};

const drawScopeAndFooter = (pdf, report) => {
  let y = 76;
  wrapText(report.scopeNote || '', 8, CONTENT_W).forEach((line) => {
    pdf.text(line, MARGIN, y, { fontSize: 8, color: MUTED });
    y -= 10;
  });
  pdf.line(MARGIN, 40, PAGE_W - MARGIN, 40, LINE, 0.5);
  pdf.text(
    'Tai lieu phat hanh tu dong. Gia tri xac thuc nam o ban goc tren he thong TrustCar.',
    MARGIN, 28, { fontSize: 7, color: MUTED },
  );
  pdf.text(`Ngay xuat bao cao: ${formatDate(report.generatedAt)}`, PAGE_W - MARGIN, 28, {
    fontSize: 7, color: MUTED, align: 'right',
  });
};

/**
 * @param {object} report - VehicleHistoryReport from vehicleHistoryReport.js
 * @returns {Buffer}
 */
export const renderVehicleHistoryPdf = (report) => {
  const pdf = createPdf({ width: PAGE_W, height: PAGE_H });

  // ── Page 1: identity + certification ──────────────────────────────────
  let y = drawPageOneHeader(pdf, report.certificate);
  y = drawVehicleBlock(pdf, report.vehicle || {}, y - 10);
  y = drawCriteriaTable(pdf, report.criteria || [], y - 8);

  // Small QR in the bottom-right corner of page 1 so the single page is
  // self-verifiable when printed alone.
  if (report.verifyUrl) {
    const matrix = makeQrMatrix(report.verifyUrl, { ecc: 'M' });
    drawQr(pdf, matrix, PAGE_W - MARGIN - 110, 90, 2);
    pdf.text('Quet de xac thuc', PAGE_W - MARGIN - 55, 78, {
      fontSize: 7, color: MUTED, align: 'center',
    });
  }
  drawScopeAndFooter(pdf, report);

  // ── Page 2: operating history ─────────────────────────────────────────
  pdf.newPage();
  pdf.rect(0, PAGE_H - 36, PAGE_W, 36, NAVY);
  pdf.rect(0, PAGE_H - 40, PAGE_W, 4, GOLD);
  pdf.text('LICH SU VAN HANH', MARGIN, PAGE_H - 24, {
    fontSize: 11, bold: true, color: [1, 1, 1],
  });

  y = PAGE_H - 60;
  y = drawOwnershipBlock(pdf, report.ownership || {}, y);
  y = drawOdoHistory(pdf, report.odometerHistory, y - 6);
  y = drawPriceHistory(pdf, report.priceHistory, y - 6);
  y = drawMaintenance(pdf, report.maintenance, y - 6);
  drawScopeAndFooter(pdf, report);

  // ── Page 3: inspections + verify ──────────────────────────────────────
  pdf.newPage();
  pdf.rect(0, PAGE_H - 36, PAGE_W, 36, NAVY);
  pdf.rect(0, PAGE_H - 40, PAGE_W, 4, GOLD);
  pdf.text('KIEM DINH & XAC THUC', MARGIN, PAGE_H - 24, {
    fontSize: 11, bold: true, color: [1, 1, 1],
  });

  y = PAGE_H - 60;
  y = drawInspections(pdf, report.inspections, y);
  y = drawMinorDefects(pdf, report.minorDefects, y - 6);
  drawVerifyBlock(pdf, report, y - 6);
  drawScopeAndFooter(pdf, report);

  return pdf.toBuffer();
};

export default { renderVehicleHistoryPdf };
