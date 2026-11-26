import { DebouncedWriter, readJson } from './storage.ts';

/**
 * A capped list of pages: the model for both bookmarks and history.
 * Entries are keyed by URL. Ids are assigned at load time and are stable
 * only for the life of the process; they are what the UI sends back.
 */

export interface UrlEntry {
  id: number;
  url: string;
  title: string;
  /** Bookmarks: when added. History: last visit. Milliseconds since the epoch. */
  time: number;
  /** History: number of visits. Bookmarks: always 1. */
  count: number;
}

const MAX_URL = 4096;
const MAX_TITLE = 500;

/** Which URLs are worth remembering. Internal, script, data and source-view URLs are not. */
export function isStorableUrl(url: string): boolean {
  if (url.length > MAX_URL) return false;
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'gopher:', 'file:'].includes(u.protocol) && !u.username && !u.password;
  } catch {
    return false;
  }
}

const cleanTitle = (t: unknown, url: string) =>
  // eslint-disable-next-line no-control-regex
  (typeof t === 'string' ? t.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE) : '') || url.slice(0, MAX_TITLE);

export interface UrlStoreOptions {
  cap: number;
  /** Where to persist; omit for a memory-only store. */
  path?: string;
  writeDelayMs?: number;
}

export class UrlStore {
  private readonly byUrl = new Map<string, UrlEntry>();
  private nextId = 1;
  private readonly cap: number;
  private readonly writer: DebouncedWriter | undefined;
  private readonly listeners = new Set<() => void>();
  readonly loadProblems: string[] = [];

  constructor(options: UrlStoreOptions) {
    this.cap = options.cap;
    if (options.path) {
      this.writer = new DebouncedWriter(options.path, () => this.toJSON(), options.writeDelayMs);
      const read = readJson(options.path);
      if (read.kind === 'corrupt') this.loadProblems.push(`${options.path} was unreadable and was moved to ${read.movedTo}`);
      if (read.kind === 'ok') this.load(read.value);
    }
  }

  private load(raw: unknown): void {
    const list = typeof raw === 'object' && raw !== null && Array.isArray((raw as { entries?: unknown }).entries)
      ? (raw as { entries: unknown[] }).entries
      : [];
    let skipped = 0;
    for (const e of list.slice(0, this.cap * 2)) {
      const r = e as Partial<Record<keyof UrlEntry, unknown>>;
      if (typeof e !== 'object' || e === null || typeof r.url !== 'string' || !isStorableUrl(r.url) || this.byUrl.has(r.url)) { skipped++; continue; }
      const time = typeof r.time === 'number' && Number.isFinite(r.time) ? r.time : 0;
      const count = typeof r.count === 'number' && Number.isInteger(r.count) && r.count > 0 ? Math.min(r.count, 1e9) : 1;
      this.byUrl.set(r.url, { id: this.nextId++, url: r.url, title: cleanTitle(r.title, r.url), time, count });
    }
    if (skipped > 0) this.loadProblems.push(`${skipped} invalid entr${skipped === 1 ? 'y was' : 'ies were'} dropped`);
    this.trim();
  }

  toJSON(): { version: 1; entries: Omit<UrlEntry, 'id'>[] } {
    return { version: 1, entries: this.sorted().map(({ id: _id, ...rest }) => rest) };
  }

  private changed(): void {
    this.writer?.schedule();
    for (const l of this.listeners) l();
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  flush(): void {
    this.writer?.flush();
  }

  private sorted(): UrlEntry[] {
    return [...this.byUrl.values()].sort((a, b) => b.time - a.time || b.id - a.id);
  }

  /** Drop the oldest entries beyond the cap. */
  private trim(): void {
    if (this.byUrl.size <= this.cap) return;
    for (const e of this.sorted().slice(this.cap)) this.byUrl.delete(e.url);
  }

  get size(): number {
    return this.byUrl.size;
  }

  has(url: string): boolean {
    return this.byUrl.has(url);
  }

  get(id: number): UrlEntry | undefined {
    for (const e of this.byUrl.values()) if (e.id === id) return { ...e };
    return undefined;
  }

  /** Add an entry if absent (bookmarks). Returns false for URLs that are not stored. */
  add(url: string, title: string, now: number): boolean {
    if (!isStorableUrl(url)) return false;
    if (this.byUrl.has(url)) return true;
    this.byUrl.set(url, { id: this.nextId++, url, title: cleanTitle(title, url), time: now, count: 1 });
    this.trim();
    this.changed();
    return true;
  }

  /** Record a visit (history): add, or move to the top and count it. */
  visit(url: string, title: string, now: number): boolean {
    if (!isStorableUrl(url)) return false;
    const e = this.byUrl.get(url);
    if (e) {
      e.time = Math.max(e.time, now);
      e.count = Math.min(e.count + 1, 1e9);
      if (title) e.title = cleanTitle(title, url);
    } else {
      this.byUrl.set(url, { id: this.nextId++, url, title: cleanTitle(title, url), time: now, count: 1 });
      this.trim();
    }
    this.changed();
    return true;
  }

  /** Update the title of an existing entry (titles often arrive after the visit). */
  setTitle(url: string, title: string): void {
    const e = this.byUrl.get(url);
    if (!e || !title) return;
    const t = cleanTitle(title, url);
    if (t === e.title) return;
    e.title = t;
    this.changed();
  }

  remove(id: number): boolean {
    for (const [url, e] of this.byUrl) {
      if (e.id === id) { this.byUrl.delete(url); this.changed(); return true; }
    }
    return false;
  }

  removeUrl(url: string): boolean {
    const removed = this.byUrl.delete(url);
    if (removed) this.changed();
    return removed;
  }

  clear(): void {
    if (this.byUrl.size === 0) return;
    this.byUrl.clear();
    this.changed();
  }

  /** Newest first. Every word of the query must appear in the title or URL. */
  search(query: string, limit = 200): UrlEntry[] {
    const words = query.toLowerCase().slice(0, 200).split(/\s+/).filter(Boolean).slice(0, 8);
    const out: UrlEntry[] = [];
    for (const e of this.sorted()) {
      const hay = `${e.title}\n${e.url}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push({ ...e });
      if (out.length >= limit) break;
    }
    return out;
  }
}
