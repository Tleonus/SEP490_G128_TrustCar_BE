/**
 * @file qrMatrix.js
 * @description Dependency-free QR Code generator (QR Code Model 2, byte mode).
 *
 * Implements the ISO/IEC 18004 encoding pipeline up to version 10, which covers
 * every URL this project needs to encode (a public car page plus margin). The
 * output is the raw module grid; rendering (PDF, SVG, PNG) is the caller's job.
 *
 * References: ISO/IEC 18004:2015 — encoding (§7), error correction (§7.5, Annex A
 * Reed-Solomon over GF(256) with generator polynomial 0x11d), format/version
 * information (§7.9, §7.10), data masking (§7.8).
 */

/**
 * Format-information value for each ECC level (ISO/IEC 18004 Table 12).
 * NOT the column index of the tables below — those are in L,M,Q,H order.
 */
const ECC_FORMAT = Object.freeze({ L: 1, M: 0, Q: 3, H: 2 });

/** Column index of each ECC level in the capacity / block tables (L,M,Q,H). */
const ECC_COLUMN = Object.freeze({ L: 0, M: 1, Q: 2, H: 3 });

/** Data codewords per version (index 1..10) for each ECC level, in L,M,Q,H order. */
const DATA_CODEWORDS = Object.freeze([
  null,
  [19, 16, 13, 9],
  [34, 28, 22, 16],
  [55, 44, 34, 26],
  [80, 64, 48, 36],
  [108, 86, 62, 46],
  [136, 108, 76, 60],
  [156, 124, 88, 66],
  [194, 154, 110, 86],
  [232, 182, 132, 100],
  [274, 216, 154, 122],
]);

/** Error-correction codewords per block, in L,M,Q,H order (versions 1..10). */
const EC_CODEWORDS_PER_BLOCK = Object.freeze([
  null,
  [7, 10, 13, 17],
  [10, 16, 22, 28],
  [15, 26, 18, 22],
  [20, 18, 26, 16],
  [26, 24, 18, 22],
  [18, 16, 24, 28],
  [20, 18, 18, 26],
  [24, 22, 22, 26],
  [30, 22, 20, 24],
  [18, 26, 24, 28],
]);

/** Number of error-correction blocks, in L,M,Q,H order (versions 1..10). */
const NUM_BLOCKS = Object.freeze([
  null,
  [1, 1, 1, 1],
  [1, 1, 1, 1],
  [1, 1, 2, 2],
  [1, 2, 2, 4],
  [1, 2, 4, 4],
  [2, 4, 4, 4],
  [2, 4, 6, 5],
  [2, 4, 6, 6],
  [2, 5, 8, 8],
  [4, 5, 8, 8],
]);

/** Alignment pattern center positions per version (version 1 has none). */
const ALIGNMENT_CENTERS = Object.freeze([
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]);

// ── Galois field GF(256) with the QR primitive polynomial 0x11d ──────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed-Solomon remainder of `data` for `ecLen` error-correction codewords. */
const reedSolomon = (data, ecLen) => {
  const gen = new Uint8Array(ecLen + 1);
  gen[0] = 1;
  for (let i = 0; i < ecLen; i += 1) {
    for (let j = i; j >= 0; j -= 1) gen[j + 1] ^= gfMul(gen[j], EXP[i]);
  }
  const res = new Uint8Array(ecLen);
  data.forEach((byte) => {
    const factor = byte ^ res[0];
    res.copyWithin(0, 1);
    res[ecLen - 1] = 0;
    if (factor !== 0) for (let i = 0; i < ecLen; i += 1) res[i] ^= gfMul(gen[i + 1], factor);
  });
  return res;
};

// ── Bit buffer ────────────────────────────────────────────────────────────────

const bitsOf = (buffer) => {
  const out = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) out.push((value >>> i) & 1);
  };
  return { push, get: () => out, length: () => out.length, buffer };
};

const toBytes = (bits) => {
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) byte = (byte << 1) | (bits[i + b] || 0);
    bytes.push(byte);
  }
  return bytes;
};

// ── Matrix helpers ────────────────────────────────────────────────────────────

const inRange = (size, r, c) => r >= 0 && c >= 0 && r < size && c < size;

/** Marks a square region as reserved (a function pattern) and paints it. */
const paint = (matrix, reserved, r, c, dark) => {
  matrix[r][c] = dark ? 1 : 0;
  reserved[r][c] = true;
};

const finderPattern = (matrix, reserved, top, left) => {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      if (!inRange(matrix.length, top + r, left + c)) continue;
      const edge = r === -1 || r === 7 || c === -1 || c === 7;
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      paint(matrix, reserved, top + r, left + c, !edge && (ring || core));
    }
  }
};

const alignmentPattern = (matrix, reserved, centerR, centerC) => {
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
      paint(matrix, reserved, centerR + r, centerC + c, dark);
    }
  }
};

/** Places finder, timing, alignment, separator and dark-module patterns. */
const placeFunctionPatterns = (version) => {
  const size = 17 + version * 4;
  const matrix = Array.from({ length: size }, () => new Array(size).fill(0));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  [[0, 0], [0, size - 7], [size - 7, 0]].forEach(([r, c]) => finderPattern(matrix, reserved, r, c));

  // Timing patterns run along row 6 and column 6 *between* the finders.
  for (let i = 0; i < size; i += 1) {
    if (!reserved[6][i]) paint(matrix, reserved, 6, i, i % 2 === 0);
    if (!reserved[i][6]) paint(matrix, reserved, i, 6, i % 2 === 0);
  }

  // Alignment patterns go on every (row, col) combination of the centre list
  // except the three that land on a finder pattern (top-left, top-right,
  // bottom-left) — ISO §7.3.5. Painted after the timing pattern so that where
  // the two overlap the alignment pattern wins.
  const centers = ALIGNMENT_CENTERS[version];
  const last = centers.length - 1;
  centers.forEach((r, ri) => centers.forEach((c, ci) => {
    const onFinder = (ri === 0 && ci === 0) || (ri === 0 && ci === last) || (ri === last && ci === 0);
    if (onFinder) return;
    alignmentPattern(matrix, reserved, r, c);
  }));

  paint(matrix, reserved, size - 8, 8, true); // dark module

  // Reserve the format-information strips (filled in after masking).
  for (let i = 0; i < 9; i += 1) { reserved[8][i] = true; reserved[i][8] = true; }
  for (let i = 0; i < 8; i += 1) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }

  // Versions 7 and up carry an 18-bit version block twice, next to the finders.
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      reserved[Math.floor(i / 3)][(i % 3) + size - 11] = true;
      reserved[(i % 3) + size - 11][Math.floor(i / 3)] = true;
    }
  }

  return { matrix, reserved, size };
};

/** Writes the 18-bit version information (ISO §7.10) for versions 7 and up. */
const writeVersion = (matrix, version) => {
  if (version < 7) return;
  const G18 = 0b1111100100101;
  const bchDigit = (n) => { let d = 0; while (n !== 0) { d += 1; n >>>= 1; } return d; };
  let d = version << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  const bits = (version << 12) | d;
  const size = matrix.length;
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) === 1 ? 1 : 0;
    matrix[Math.floor(i / 3)][(i % 3) + size - 11] = dark;
    matrix[(i % 3) + size - 11][Math.floor(i / 3)] = dark;
  }
};

/** Zigzag placement of data bits into the modules not reserved for patterns. */
const placeData = (matrix, reserved, bits) => {
  const { length: size } = matrix;
  let bit = 0;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < size; vert += 1) {
      const row = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      for (let col = right; col >= right - 1; col -= 1) {
        if (reserved[row][col]) continue;
        matrix[row][col] = bit < bits.length && bits[bit] ? 1 : 0;
        bit += 1;
      }
    }
  }
};

// ── Masking and penalty scoring (ISO/IEC 18004 §7.8.3) ───────────────────────

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

const penalty = (matrix) => {
  const size = matrix.length;
  let score = 0;

  const runPenalty = (line) => {
    let run = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) { run += 1; continue; }
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
    }
    if (run >= 5) score += 3 + (run - 5);
  };
  for (let i = 0; i < size; i += 1) {
    runPenalty(matrix[i]);
    runPenalty(matrix.map((row) => row[i]));
  }

  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) score += 3;
    }
  }

  const finder = (line) => {
    const s = line.join('');
    for (let i = 0; i <= s.length - 11; i += 1) {
      if (s.startsWith('10111010000', i) || s.startsWith('00001011101', i)) score += 40;
    }
  };
  for (let i = 0; i < size; i += 1) {
    finder(matrix[i]);
    finder(matrix.map((row) => row[i]));
  }

  const dark = matrix.reduce((sum, row) => sum + row.reduce((a, b) => a + b, 0), 0);
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
};

/** Writes the 15-bit format information for an ECC level and mask. */
const writeFormat = (matrix, eccIndex, mask) => {
  const FORMAT_POLY = 0x537;
  let data = ((eccIndex << 3) | mask) << 10;
  for (let i = 14; i >= 10; i -= 1) if ((data >>> i) & 1) data ^= FORMAT_POLY << (i - 10);
  const bits = (((eccIndex << 3) | mask) << 10 | data) ^ 0b101010000010010;
  const size = matrix.length;
  // Bit i lands in two mirrored strips (ISO §7.9.1). Bit 0 is written first.
  //   horizontal copy: row 8, columns size-1..size-8 then 7..0 (skipping the timing column)
  //   vertical copy:   column 8, rows 0..5, 7, 8 then size-7..size-1 (skipping the timing row)
  const horizontal = [
    ...Array.from({ length: 8 }, (_, k) => size - 1 - k), 7, 5, 4, 3, 2, 1, 0,
  ];
  const vertical = [
    0, 1, 2, 3, 4, 5, 7, 8, ...Array.from({ length: 7 }, (_, k) => size - 7 + k),
  ];
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    matrix[8][horizontal[i]] = dark ? 1 : 0;
    matrix[vertical[i]][8] = dark ? 1 : 0;
  }
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds a QR symbol for `text` and returns its module grid.
 *
 * @param {string} text        content to encode (byte mode, UTF-8)
 * @param {{ ecc?: 'L'|'M'|'Q'|'H' }} [options]
 * @returns {{ size: number, modules: number[][], version: number, ecc: string, mask: number }}
 *          `modules[row][col]` is 1 for a dark module, 0 for a light one.
 * @throws {Error} when the text does not fit in version 10 at the chosen ECC level.
 */
export const makeQrMatrix = (text, { ecc = 'M' } = {}) => {
  const eccIndex = ECC_FORMAT[ecc];
  if (eccIndex === undefined) throw new Error(`Unknown QR error-correction level: ${ecc}`);
  const column = ECC_COLUMN[ecc];

  const data = Buffer.from(String(text), 'utf8');

  let version = 0;
  for (let v = 1; v <= 10; v += 1) {
    const capacityBits = DATA_CODEWORDS[v][column] * 8;
    const headerBits = v >= 10 ? 20 : 12; // 4-bit mode + 8/16-bit character count
    if (headerBits + data.length * 8 <= capacityBits) { version = v; break; }
  }
  if (!version) throw new Error('QR content exceeds the supported capacity (version 10).');

  const capacity = DATA_CODEWORDS[version][column];
  const buf = bitsOf();
  buf.push(0b0100, 4);                                   // byte mode indicator
  buf.push(data.length, version >= 10 ? 16 : 8);        // character count
  data.forEach((byte) => buf.push(byte, 8));

  const capacityBits = capacity * 8;
  const terminator = Math.min(4, capacityBits - buf.length());
  buf.push(0, terminator);
  while (buf.length() % 8 !== 0) buf.push(0, 1);
  const padBytes = [0xec, 0x11];
  for (let i = 0; buf.length() < capacityBits; i += 1) buf.push(padBytes[i % 2], 8);

  const bytes = toBytes(buf.get());
  const ecPerBlock = EC_CODEWORDS_PER_BLOCK[version][column];
  const blocks = NUM_BLOCKS[version][column];
  // ISO §7.6: split the *symbol* codewords into blocks, not just the data ones.
  // The first `blocks - longBlocks` blocks are one codeword shorter.
  const totalCodewords = bytes.length + ecPerBlock * blocks;
  const shortBlockLen = Math.floor(totalCodewords / blocks);
  const longBlocks = totalCodewords % blocks;

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < blocks; b += 1) {
    const len = shortBlockLen - ecPerBlock + (b >= blocks - longBlocks ? 1 : 0);
    const block = bytes.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(Array.from(reedSolomon(block, ecPerBlock)));
  }

  const interleaved = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) dataBlocks.forEach((b) => { if (i < b.length) interleaved.push(b[i]); });
  for (let i = 0; i < ecPerBlock; i += 1) ecBlocks.forEach((b) => interleaved.push(b[i]));

  const allBits = [];
  interleaved.forEach((byte) => { for (let i = 7; i >= 0; i -= 1) allBits.push((byte >>> i) & 1); });

  const { matrix, reserved, size } = placeFunctionPatterns(version);
  placeData(matrix, reserved, allBits);

  let bestMask = 0;
  let bestScore = Infinity;
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = matrix.map((row) => row.slice());
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (!reserved[r][c] && MASKS[mask](r, c)) candidate[r][c] ^= 1;
      }
    }
    writeFormat(candidate, eccIndex, mask);
    writeVersion(candidate, version);
    const score = penalty(candidate);
    if (score < bestScore) { bestScore = score; bestMask = mask; best = candidate; }
  }

  return { size, modules: best, version, ecc, mask: bestMask };
};

export default { makeQrMatrix };
