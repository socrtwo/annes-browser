/**
 * List and extract InstallShield 3 ".z" archives (signature 13 5D 65 8C), whose
 * members are DCL-imploded. Layout as documented by the unshieldv3 project.
 */
import { blast } from './blast.ts';

export interface Is3Entry { path: string; size: number; compressedSize: number; offset: number }

export function listIs3(b: Buffer): Is3Entry[] {
  if (b.readUInt32LE(0) !== 0x8c655d13) throw new Error('not an InstallShield 3 archive');
  const fileCount = b.readUInt16LE(0x0c);
  const toc = b.readUInt32LE(0x29);
  const dirCount = b.readUInt16LE(0x31);
  let o = toc;
  const dirs: string[] = [];
  for (let i = 0; i < dirCount; i++) {
    const chunk = b.readUInt16LE(o + 2);
    const nameLen = b.readUInt16LE(o + 4);
    dirs.push(b.toString('latin1', o + 6, o + 6 + nameLen).replace(/\\/g, '/'));
    o += chunk;
  }
  const out: Is3Entry[] = [];
  for (let i = 0; i < fileCount; i++) {
    const dir = b.readUInt16LE(o + 1);
    const size = b.readUInt32LE(o + 3);
    const compressedSize = b.readUInt32LE(o + 7);
    const offset = b.readUInt32LE(o + 11);
    const chunk = b.readUInt16LE(o + 23);
    const nameLen = b.readUInt8(o + 29);
    const name = b.toString('latin1', o + 30, o + 30 + nameLen);
    const d = dirs[dir] ?? '';
    out.push({ path: d ? `${d}/${name}` : name, size, compressedSize, offset });
    o += chunk;
  }
  return out;
}

export function extractIs3(b: Buffer, e: Is3Entry): Buffer {
  const data = blast(b.subarray(e.offset, e.offset + e.compressedSize), e.size);
  if (data.length !== e.size) throw new Error(`${e.path}: expected ${e.size} bytes, got ${data.length}`);
  return data;
}
