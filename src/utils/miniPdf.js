/**
 * @file miniPdf.js
 * @description Minimal PDF 1.4 writer with no dependencies.
 *
 * Supports text (WinAnsi encoded, Helvetica built-in font), filled rectangles and
 * stroked lines — enough for a single-page certificate. Coordinates are in points
 * with the origin at the bottom-left, matching the PDF spec. Multi-byte characters
 * that have no WinAnsi equivalent (e.g. Vietnamese tone marks) are transliterated
 * to their base letter so the text stays readable without embedding a font.
 */

const WIN_ANSI_EXTRA = new Map([
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84], ['…', 0x85], ['†', 0x86],
  ['‡', 0x87], ['ˆ', 0x88], ['‰', 0x89], ['Š', 0x8a], ['‹', 0x8b], ['Œ', 0x8c],
  ['Ž', 0x8e], ['‘', 0x91], ['’', 0x92], ['“', 0x93], ['”', 0x94], ['•', 0x95],
  ['–', 0x96], ['—', 0x97], ['˜', 0x98], ['™', 0x99], ['š', 0x9a], ['›', 0x9b],
  ['œ', 0x9c], ['ž', 0x9e], ['Ÿ', 0x9f],
]);

/** Strips combining marks so "ệ" becomes "e" before WinAnsi encoding. */
const fold = (text) => String(text)
  .replace(/đ/g, 'd').replace(/Đ/g, 'D')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '');

const encodeWinAnsi = (text) => {
  const bytes = [];
  fold(text).split('').forEach((ch) => {
    const code = ch.codePointAt(0);
    if (WIN_ANSI_EXTRA.has(ch)) bytes.push(WIN_ANSI_EXTRA.get(ch));
    else if (code >= 0x20 && code <= 0xff) bytes.push(code);
    else bytes.push(0x3f); // '?'
  });
  return Buffer.from(bytes);
};

const escapeLiteral = (bytes) => {
  const out = [];
  bytes.forEach((b) => {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  });
  return Buffer.from(out);
};

/** Average character width in Helvetica, as a fraction of the font size. */
const CHAR_WIDTH = Object.freeze({
  narrow: 0.28, // i l I j t f r
  wide: 0.72,   // m w M W
  digit: 0.56,
  space: 0.28,
  default: 0.5,
});

const charWidth = (ch) => {
  if (ch === ' ') return CHAR_WIDTH.space;
  if (ch >= '0' && ch <= '9') return CHAR_WIDTH.digit;
  if ('iltjfr'.includes(ch)) return CHAR_WIDTH.narrow;
  if ('ILT'.includes(ch)) return CHAR_WIDTH.narrow + 0.05;
  if ('mw'.includes(ch) || 'MW'.includes(ch)) return CHAR_WIDTH.wide;
  if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) return 0.64;
  return CHAR_WIDTH.default;
};

/** Width of `text` in points at the given font size. */
export const textWidth = (text, fontSize) =>
  fold(text).split('').reduce((sum, ch) => sum + charWidth(ch) * fontSize, 0);

/** Splits text into lines that fit within `maxWidth` points. */
export const wrapText = (text, fontSize, maxWidth) => {
  const words = fold(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, fontSize) <= maxWidth) { current = candidate; return; }
    if (current) lines.push(current);
    current = word;
  });
  if (current) lines.push(current);
  return lines.length ? lines : [''];
};

/**
 * Builds a one-page PDF document.
 * @param {{ width?: number, height?: number }} [options] page size in points (default A4).
 */
export const createPdf = ({ width = 595.28, height = 841.89 } = {}) => {
  const commands = [];
  const num = (n) => Number(n).toFixed(2);

  return {
    width,
    height,

    /** Filled rectangle. `color` is [r, g, b] in 0..1. */
    rect(x, y, w, h, color = [0, 0, 0]) {
      commands.push(`${num(color[0])} ${num(color[1])} ${num(color[2])} rg`);
      commands.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`);
    },

    /** Stroked rectangle outline. */
    strokeRect(x, y, w, h, color = [0, 0, 0], lineWidth = 0.6) {
      commands.push(`${num(color[0])} ${num(color[1])} ${num(color[2])} RG`);
      commands.push(`${num(lineWidth)} w`);
      commands.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re S`);
    },

    /** Horizontal or vertical line. */
    line(x1, y1, x2, y2, color = [0, 0, 0], lineWidth = 0.6) {
      commands.push(`${num(color[0])} ${num(color[1])} ${num(color[2])} RG`);
      commands.push(`${num(lineWidth)} w`);
      commands.push(`${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
    },

    /**
     * Draws text. `align` is 'left' | 'center' | 'right' relative to `x`.
     * @returns {number} the baseline y actually used.
     */
    text(str, x, y, { fontSize = 12, color = [0, 0, 0], align = 'left', bold = false } = {}) {
      const font = bold ? '/F2' : '/F1';
      const width2 = textWidth(str, fontSize);
      const drawX = align === 'center' ? x - width2 / 2 : align === 'right' ? x - width2 : x;
      const literal = escapeLiteral(encodeWinAnsi(str)).toString('latin1');
      commands.push('BT');
      commands.push(`${num(color[0])} ${num(color[1])} ${num(color[2])} rg`);
      commands.push(`${font} ${num(fontSize)} Tf`);
      commands.push(`${num(drawX)} ${num(y)} Td`);
      commands.push(`(${literal}) Tj`);
      commands.push('ET');
      return y;
    },

    /** @returns {Buffer} the finished PDF. */
    toBuffer() {
      const content = Buffer.from(`${commands.join('\n')}\n`, 'latin1');
      const objects = [];
      const add = (body) => { objects.push(body); return objects.length; };

      const catalogId = add('<< /Type /Catalog /Pages 2 0 R >>');
      const pagesId = add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
      const pageId = add([
        '<< /Type /Page',
        `/Parent ${pagesId} 0 R`,
        `/MediaBox [0 0 ${num(width)} ${num(height)}]`,
        '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >>',
        '/Contents 4 0 R >>',
      ].join(' '));
      const contentId = add(`<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}endstream`);
      add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

      // Object numbers above assume this exact insertion order; assert it.
      if ([catalogId, pagesId, pageId, contentId].some((id, i) => id !== i + 1)) {
        throw new Error('Unexpected PDF object ordering.');
      }

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
    },
  };
};

export default { createPdf, textWidth, wrapText };
