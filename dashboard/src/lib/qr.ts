/**
 * A minimal QR Code encoder (ISO/IEC 18004), byte mode, error-correction
 * level Q.
 *
 * Why hand-written: the only thing the dashboard ever needs to encode is the
 * HomeKit setup URI (`X-HM://0024K0Y2WABCD`, twenty characters), and the Pi
 * serves this bundle on a LAN that may have no route to the internet, so the
 * QR image cannot come from a remote service and a general-purpose QR library
 * is several times the size of the whole System page. This is the smallest
 * thing that produces a *correct*, scannable code — an approximate QR is worse
 * than none, so nothing here is fudged: real Reed-Solomon over GF(256), real
 * block interleaving, real mask selection by the standard's penalty rules.
 *
 * Scope, deliberately narrow:
 *   - Byte mode only. Alphanumeric mode would pack the setup URI into fewer
 *     modules, but it is a second encoder to get right for no practical gain.
 *   - Error-correction level Q (25% recovery). A code on a phone screen gets
 *     photographed at an angle in a dim room; Q is the level Apple's own
 *     pairing labels use.
 *   - Versions 1 to 10, i.e. up to 151 bytes. Ample for a setup URI, and it
 *     keeps the block tables short enough to be checked by eye.
 *
 * Verified by round-tripping the output through an independent decoder: every
 * sample from one byte to the 151-byte ceiling scans back to the exact input.
 *
 * The structure follows Nayuki's reference implementation, which is the
 * clearest published expression of the specification's awkward parts (the
 * zigzag codeword walk, the finder-pattern penalty).
 */

/** A square grid of modules. `modules[y][x]` is true where the code is dark. */
export interface QrMatrix {
  /** Width and height in modules, `17 + 4 * version`. */
  size: number;
  version: number;
  modules: boolean[][];
}

/** Thrown when the payload cannot be encoded within version 10 at level Q. */
export class QrTooLongError extends Error {
  constructor(bytes: number) {
    super(`${bytes} bytes is too long for a version-10 QR code at level Q.`);
    this.name = 'QrTooLongError';
  }
}

const MIN_VERSION = 1;
const MAX_VERSION = 10;

/**
 * Error-correction codewords per block, and block count, for level Q.
 * Indexed by `version - 1`. Cross-check: `rawCodewords(v) - blocks * ecc`
 * must equal the standard data-codeword count (13, 22, 34, 48, 62, 76, 88,
 * 110, 132, 154).
 */
const ECC_PER_BLOCK_Q = [13, 22, 18, 26, 18, 24, 18, 22, 20, 24] as const;
const NUM_BLOCKS_Q = [1, 1, 2, 2, 4, 4, 6, 6, 8, 8] as const;

/** Level Q is `0b11` in the format-information field. */
const FORMAT_BITS_Q = 3;

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Encode `text` as a QR matrix.
 *
 * @throws {QrTooLongError} when the UTF-8 encoding exceeds version 10.
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = utf8(text);
  const version = pickVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);
  return buildMatrix(codewords, version);
}

/** How many data codewords a version holds at level Q. */
function dataCodewords(version: number): number {
  return rawCodewords(version) - numBlocks(version) * eccPerBlock(version);
}

function pickVersion(byteLength: number): number {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    // 4 bits of mode indicator plus the character-count field.
    const headerBits = 4 + (version < 10 ? 8 : 16);
    if (headerBits + byteLength * 8 <= dataCodewords(version) * 8) return version;
  }
  throw new QrTooLongError(byteLength);
}

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

// ---------------------------------------------------------------------------
// Table lookups
// ---------------------------------------------------------------------------

function eccPerBlock(version: number): number {
  const value = ECC_PER_BLOCK_Q[version - 1];
  if (value === undefined) throw new RangeError(`Unsupported QR version ${version}.`);
  return value;
}

function numBlocks(version: number): number {
  const value = NUM_BLOCKS_Q[version - 1];
  if (value === undefined) throw new RangeError(`Unsupported QR version ${version}.`);
  return value;
}

/**
 * Total modules available for data and error correction, in bits — the whole
 * symbol minus every function pattern. Straight from the specification's
 * formula rather than a table, because the table is 40 rows of numbers nobody
 * can proofread.
 */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function rawCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8);
}

/** Centre coordinates of the alignment patterns, ascending. */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = 17 + 4 * version;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---------------------------------------------------------------------------
// Bit stream -> data codewords
// ---------------------------------------------------------------------------

class BitBuffer {
  readonly bits: number[] = [];

  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  toBytes(): number[] {
    const bytes: number[] = new Array<number>(Math.ceil(this.bits.length / 8)).fill(0);
    this.bits.forEach((bit, index) => {
      if (bit) bytes[index >>> 3] = (bytes[index >>> 3] ?? 0) | (0x80 >>> (index & 7));
    });
    return bytes;
  }
}

/** Mode indicator, length, payload, terminator, padding, ECC, interleave. */
function buildCodewords(bytes: readonly number[], version: number): number[] {
  const capacityBits = dataCodewords(version) * 8;
  const buffer = new BitBuffer();

  buffer.append(0b0100, 4); // byte mode
  buffer.append(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) buffer.append(byte, 8);

  // Terminator: up to four zero bits, then zeros to the next byte boundary.
  buffer.append(0, Math.min(4, capacityBits - buffer.length));
  buffer.append(0, (8 - (buffer.length % 8)) % 8);

  // Alternating pad bytes, per the specification.
  const padding = [0xec, 0x11];
  for (let i = 0; buffer.length < capacityBits; i++) {
    buffer.append(padding[i % 2] ?? 0xec, 8);
  }

  return addEccAndInterleave(buffer.toBytes(), version);
}

/**
 * Split the data into blocks, append each block's Reed-Solomon remainder, and
 * interleave the lot the way the reader expects: all first codewords of every
 * block, then all second codewords, and so on — which is what makes a burst of
 * damage spread thinly across blocks instead of destroying one outright.
 */
function addEccAndInterleave(data: readonly number[], version: number): number[] {
  const blocks = numBlocks(version);
  const eccLength = eccPerBlock(version);
  const total = rawCodewords(version);

  const shortBlockLength = Math.floor(total / blocks);
  const shortBlockCount = blocks - (total % blocks);
  const divisor = rsDivisor(eccLength);

  const built: number[][] = [];
  let cursor = 0;
  for (let i = 0; i < blocks; i++) {
    const dataLength = shortBlockLength - eccLength + (i < shortBlockCount ? 0 : 1);
    const chunk = data.slice(cursor, cursor + dataLength);
    cursor += dataLength;
    const ecc = rsRemainder(chunk, divisor);
    // A short block gets a placeholder so every block has the same length and
    // the interleave below can be a plain column walk; the placeholder is
    // skipped when it is read back out.
    if (i < shortBlockCount) chunk.push(0);
    built.push([...chunk, ...ecc]);
  }

  const result: number[] = [];
  const columns = built[0]?.length ?? 0;
  for (let i = 0; i < columns; i++) {
    built.forEach((block, index) => {
      if (i === shortBlockLength - eccLength && index < shortBlockCount) return;
      const value = block[i];
      if (value !== undefined) result.push(value);
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reed-Solomon over GF(256), primitive polynomial 0x11D
// ---------------------------------------------------------------------------

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Coefficients of the generator polynomial of the given degree. */
function rsDivisor(degree: number): number[] {
  const result: number[] = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j] ?? 0, root);
      if (j + 1 < result.length) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    divisor.forEach((coefficient, index) => {
      result[index] = (result[index] ?? 0) ^ gfMultiply(coefficient, factor);
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

class Symbol_ {
  readonly size: number;
  readonly modules: boolean[][];
  /** Modules belonging to a function pattern, which masking must not touch. */
  private readonly reserved: boolean[][];

  constructor(readonly version: number) {
    this.size = 17 + 4 * version;
    this.modules = grid(this.size);
    this.reserved = grid(this.size);
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const row = this.modules[y];
    const flags = this.reserved[y];
    if (!row || !flags) return;
    row[x] = dark;
    flags[x] = true;
  }

  private isReserved(x: number, y: number): boolean {
    return this.reserved[y]?.[x] === true;
  }

  private get(x: number, y: number): boolean {
    return this.modules[y]?.[x] === true;
  }

  private set(x: number, y: number, dark: boolean): void {
    const row = this.modules[y];
    if (row) row[x] = dark;
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }

    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    const positions = alignmentPositions(this.version);
    const last = positions.length - 1;
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        // The three finder corners already own those cells.
        const corner = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
        if (corner) continue;
        this.drawAlignment(positions[i] ?? 0, positions[j] ?? 0);
      }
    }

    // Reserve the format area with a placeholder; the real bits go in once a
    // mask has been chosen.
    this.drawFormatBits(0);
    this.drawVersionBits();
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        this.setFunction(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  /** 15 bits: 5 of data, 10 of BCH remainder, XORed with the fixed mask. */
  drawFormatBits(mask: number): void {
    const data = (FORMAT_BITS_Q << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) {
      remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    }
    const bits = ((data << 10) | remainder) ^ 0x5412;

    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(bits, i));
    this.setFunction(8, 7, bit(bits, 6));
    this.setFunction(8, 8, bit(bits, 7));
    this.setFunction(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(bits, i));

    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(bits, i));
    // The lone module that is always dark, just above the bottom-left finder.
    this.setFunction(8, this.size - 8, true);
  }

  private drawVersionBits(): void {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i++) {
      remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    }
    const bits = (this.version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = bit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  /** The zigzag walk: two-module-wide columns, right to left, alternating up and down. */
  drawCodewords(codewords: readonly number[]): void {
    let index = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      // Column 6 is the vertical timing pattern; the pair shifts left past it.
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < this.size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vertical : vertical;
          if (this.isReserved(x, y) || index >= codewords.length * 8) continue;
          const byte = codewords[index >>> 3] ?? 0;
          this.set(x, y, bit(byte, 7 - (index & 7)));
          index++;
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isReserved(x, y)) continue;
        if (maskAt(mask, x, y)) this.set(x, y, !this.get(x, y));
      }
    }
  }

  /**
   * The specification's four penalty rules, summed. Lower is better; the mask
   * with the lowest score is the one a reader will find easiest.
   */
  penalty(): number {
    let result = 0;
    const size = this.size;

    for (let y = 0; y < size; y++) {
      let runColor = false;
      let runLength = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (this.get(x, y) === runColor) {
          runLength++;
          if (runLength === 5) result += PENALTY_N1;
          else if (runLength > 5) result += 1;
        } else {
          this.pushRun(runLength, history);
          if (!runColor) result += countFinderLike(history) * PENALTY_N3;
          runColor = this.get(x, y);
          runLength = 1;
        }
      }
      result += this.terminateRun(runColor, runLength, history) * PENALTY_N3;
    }

    for (let x = 0; x < size; x++) {
      let runColor = false;
      let runLength = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (this.get(x, y) === runColor) {
          runLength++;
          if (runLength === 5) result += PENALTY_N1;
          else if (runLength > 5) result += 1;
        } else {
          this.pushRun(runLength, history);
          if (!runColor) result += countFinderLike(history) * PENALTY_N3;
          runColor = this.get(x, y);
          runLength = 1;
        }
      }
      result += this.terminateRun(runColor, runLength, history) * PENALTY_N3;
    }

    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = this.get(x, y);
        if (
          color === this.get(x + 1, y) &&
          color === this.get(x, y + 1) &&
          color === this.get(x + 1, y + 1)
        ) {
          result += PENALTY_N2;
        }
      }
    }

    let dark = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (this.get(x, y)) dark++;
    }
    const total = size * size;
    const deviation = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += deviation * PENALTY_N4;

    return result;
  }

  private pushRun(length: number, history: number[]): void {
    // The quiet zone counts as light, so the first run gets a virtual border.
    const value = history[0] === 0 ? length + this.size : length;
    history.pop();
    history.unshift(value);
  }

  private terminateRun(runColor: boolean, runLength: number, history: number[]): number {
    let length = runLength;
    if (runColor) {
      this.pushRun(length, history);
      length = 0;
    }
    this.pushRun(length + this.size, history);
    return countFinderLike(history);
  }
}

function buildMatrix(codewords: readonly number[], version: number): QrMatrix {
  const symbol = new Symbol_(version);
  symbol.drawFunctionPatterns();
  symbol.drawCodewords(codewords);

  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    symbol.applyMask(mask);
    symbol.drawFormatBits(mask);
    const score = symbol.penalty();
    if (score < bestPenalty) {
      bestPenalty = score;
      bestMask = mask;
    }
    symbol.applyMask(mask); // XOR is its own inverse: undo before the next try.
  }

  symbol.applyMask(bestMask);
  symbol.drawFormatBits(bestMask);

  return { size: symbol.size, version, modules: symbol.modules };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function grid(size: number): boolean[][] {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

function maskAt(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return false;
  }
}

/** How many finder-like 1:1:3:1:1 runs the history ends in (0, 1 or 2). */
function countFinderLike(history: readonly number[]): number {
  const n = history[1] ?? 0;
  const core =
    n > 0 &&
    history[2] === n &&
    history[3] === n * 3 &&
    history[4] === n &&
    history[5] === n;
  const before = (history[0] ?? 0) >= n * 4 && (history[6] ?? 0) >= n;
  const after = (history[6] ?? 0) >= n * 4 && (history[0] ?? 0) >= n;
  return (core && before ? 1 : 0) + (core && after ? 1 : 0);
}

// ---------------------------------------------------------------------------
// SVG path
// ---------------------------------------------------------------------------

/**
 * The whole code as a single SVG path in a `0 0 size size` user space (plus
 * `quietZone` modules of margin), so it renders as one `<path>` rather than a
 * few hundred `<rect>` elements.
 */
export function qrPath(matrix: QrMatrix, quietZone = 2): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y++) {
    const row = matrix.modules[y];
    if (!row) continue;
    let x = 0;
    while (x < matrix.size) {
      if (row[x] !== true) {
        x++;
        continue;
      }
      // Merge each horizontal run into one rectangle: fewer path commands and
      // no hairline seams between adjacent modules when the browser rounds.
      let run = 1;
      while (x + run < matrix.size && row[x + run] === true) run++;
      parts.push(`M${x + quietZone} ${y + quietZone}h${run}v1h-${run}z`);
      x += run;
    }
  }
  return parts.join('');
}

/** Side length of the `viewBox` that {@link qrPath} draws into. */
export function qrViewBoxSize(matrix: QrMatrix, quietZone = 2): number {
  return matrix.size + quietZone * 2;
}
