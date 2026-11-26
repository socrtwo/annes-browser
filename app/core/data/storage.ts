import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Small JSON files for settings, bookmarks and history. Writes are atomic
 * (temporary file, fsync, rename), so a crash leaves either the old file or
 * the new one, never half of each.
 */

export type ReadResult = { kind: 'ok'; value: unknown } | { kind: 'missing' } | { kind: 'corrupt'; movedTo: string };

const MAX_FILE_BYTES = 32 * 1024 * 1024;

/**
 * Read a JSON file. A file that cannot be parsed is moved aside (so it is
 * not overwritten and can be recovered by hand) and reported as corrupt.
 */
export function readJson(path: string): ReadResult {
  let text: string;
  try {
    const bytes = readFileSync(path);
    if (bytes.length > MAX_FILE_BYTES) throw new SyntaxError('file too large');
    text = bytes.toString('utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    if (!(e instanceof SyntaxError)) throw e;
    text = '';
  }
  try {
    if (text === '') throw new SyntaxError('empty or oversized file');
    return { kind: 'ok', value: JSON.parse(text) as unknown };
  } catch {
    const movedTo = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, movedTo); } catch { /* leave it where it is */ }
    return { kind: 'corrupt', movedTo };
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(value, null, 1));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Coalesces frequent changes (history visits) into one write after a quiet
 * period. `flush` writes immediately and must be called on shutdown.
 */
export class DebouncedWriter {
  private timer: NodeJS.Timeout | undefined;
  private readonly path: string;
  private readonly snapshot: () => unknown;
  private readonly delayMs: number;

  constructor(path: string, snapshot: () => unknown, delayMs = 1000) {
    this.path = path;
    this.snapshot = snapshot;
    this.delayMs = delayMs;
  }

  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    writeJsonAtomic(this.path, this.snapshot());
  }
}
