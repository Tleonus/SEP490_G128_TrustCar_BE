/**
 * @file mini-pdf-pages.test.js
 * @description KAN-98 — multi-page extension of miniPdf.
 * The single-page branch must stay byte-identical to the pre-KAN-98 output so
 * the CPO certificate PDF does not change.
 */

import { createPdf } from '../src/utils/miniPdf.js';

/** Rebuilds the exact pre-KAN-98 single-page output for the same commands. */
const legacySinglePage = (commands, width, height) => {
  const num = (n) => Number(n).toFixed(2);
  const content = Buffer.from(`${commands.join('\n')}\n`, 'latin1');
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalogId = add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add([
    '<< /Type /Page',
    '/Parent 2 0 R',
    `/MediaBox [0 0 ${num(width)} ${num(height)}]`,
    '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >>',
    '/Contents 4 0 R >>',
  ].join(' '));
  add(`<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}endstream`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const header = Buffer.from('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n', 'latin1');
  const parts = [header];
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(parts.reduce((sum, p) => sum + p.length, 0));
    parts.push(Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1'));
  });
  const xrefPos = parts.reduce((sum, p) => sum + p.length, 0);
  const rows = ['0000000000 65535 f \n', ...offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)];
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n${rows.join('')}`, 'latin1'));
  parts.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
};

describe('createPdf', () => {
  test('T22 — single page (no newPage) is byte-identical to the legacy output', () => {
    const pdf = createPdf();
    pdf.text('Hello', 40, 800, { fontSize: 12 });
    pdf.rect(40, 700, 100, 20, [0.1, 0.2, 0.3]);
    const actual = pdf.toBuffer();

    // Replay the same commands through the frozen legacy builder.
    const expected = legacySinglePage([
      'BT',
      '0.00 0.00 0.00 rg',
      '/F1 12.00 Tf',
      '40.00 800.00 Td',
      '(Hello) Tj',
      'ET',
      '0.10 0.20 0.30 rg',
      '40.00 700.00 100.00 20.00 re f',
    ], 595.28, 841.89);

    expect(actual.equals(expected)).toBe(true);
  });

  test('T23 — three pages: /Count 3, three content streams, valid xref', () => {
    const pdf = createPdf();
    pdf.text('Page one', 40, 800);
    pdf.newPage();
    pdf.text('Page two', 40, 800);
    pdf.newPage();
    pdf.text('Page three', 40, 800);
    const text = pdf.toBuffer().toString('latin1');

    expect(text).toContain('/Count 3');
    const kids = text.match(/\/Kids \[([^\]]+)\]/);
    expect(kids[1].trim().split(/\s+0 R/).filter(Boolean)).toHaveLength(3);

    const streams = text.match(/(?<!end)stream\n/g) || [];
    expect(streams).toHaveLength(3);
    expect(text).toContain('(Page one)');
    expect(text).toContain('(Page two)');
    expect(text).toContain('(Page three)');

    // startxref points at the xref table.
    const startxref = Number(text.match(/startxref\n(\d+)/)[1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');

    // Fonts are referenced by the ids actually assigned.
    expect(text).toMatch(/\/F1 \d+ 0 R/);
    expect(text).toMatch(/\/F2 \d+ 0 R/);
  });
});
