/**
 * Decompress PKWARE DCL "implode" data, as used inside InstallShield 3 archives
 * (the `.z` files in Netscape's 1990s installers). A port of the algorithm in
 * zlib's contrib/blast/blast.c (Mark Adler); no code is shared.
 */

const MAXBITS = 13;

interface Huffman { count: Int16Array; symbol: Int16Array }

/** Build a decoding table from blast's run-length-coded list of code lengths. */
function construct(rep: number[], n: number): Huffman {
  const length: number[] = [];
  for (const r of rep) {
    const len = r & 15;
    for (let left = (r >> 4) + 1; left > 0; left--) length.push(len);
  }
  if (length.length !== n) throw new Error('blast: bad code table');
  const count = new Int16Array(MAXBITS + 1);
  for (const l of length) count[l]!++;
  const offs = new Int16Array(MAXBITS + 2);
  for (let l = 1; l < MAXBITS; l++) offs[l + 1] = offs[l]! + count[l]!;
  const symbol = new Int16Array(n);
  length.forEach((l, s) => { if (l) symbol[offs[l]!++] = s; });
  return { count, symbol };
}

const LITLEN = [11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8, 9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5, 7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12, 8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27, 44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45, 44, 173];
const LENLEN = [2, 35, 36, 53, 38, 23];
const DISTLEN = [2, 20, 53, 230, 247, 151, 248];
const BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];

let tables: { lit: Huffman; len: Huffman; dist: Huffman } | undefined;

export function blast(input: Uint8Array, expectedSize?: number): Buffer {
  tables ??= { lit: construct(LITLEN, 256), len: construct(LENLEN, 16), dist: construct(DISTLEN, 64) };
  const { lit: litcode, len: lencode, dist: distcode } = tables;
  let pos = 0;
  let bitbuf = 0;
  let bitcnt = 0;
  const bits = (need: number): number => {
    let val = bitbuf;
    while (bitcnt < need) {
      if (pos >= input.length) throw new Error('blast: input ends early');
      val |= input[pos++]! << bitcnt;
      bitcnt += 8;
    }
    bitbuf = val >>> need;
    bitcnt -= need;
    return val & ((1 << need) - 1);
  };
  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= MAXBITS; len++) {
      code |= bits(1) ^ 1; // codes are stored inverted
      const count = h.count[len]!;
      if (code < first + count) return h.symbol[index + (code - first)]!;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('blast: bad code');
  };

  const coded = bits(8);
  if (coded > 1) throw new Error('blast: bad literal flag');
  const dict = bits(8);
  if (dict < 4 || dict > 6) throw new Error('blast: bad dictionary size');

  let out = Buffer.alloc(expectedSize ?? Math.max(4096, input.length * 4));
  let n = 0;
  const ensure = (k: number) => {
    if (n + k <= out.length) return;
    const bigger = Buffer.alloc(Math.max(out.length * 2, n + k));
    out.copy(bigger, 0, 0, n);
    out = bigger;
  };
  for (;;) {
    if (bits(1)) {
      const sym = decode(lencode);
      const len = BASE[sym]! + bits(EXTRA[sym]!);
      if (len === 519) break; // end of stream
      const shift = len === 2 ? 2 : dict;
      const dist = ((decode(distcode) << shift) + bits(shift)) + 1;
      if (dist > n) throw new Error('blast: distance too far back');
      ensure(len);
      for (let i = 0; i < len; i++, n++) out[n] = out[n - dist]!;
    } else {
      ensure(1);
      out[n++] = coded ? decode(litcode) : bits(8);
    }
  }
  return out.subarray(0, n);
}
