import { readJson, writeJsonAtomic } from './storage.ts';

/**
 * User settings. One JSON file per profile. Unknown keys are dropped on load
 * and invalid values fall back to their defaults, so a hand-edited or old
 * file can never put the browser into a state the code does not expect.
 */

export interface Settings {
  version: 1;
  /** Menu layout id for new windows. */
  layout: string;
  /** Keymap id for new windows. */
  keymap: string;
  /** Page loaded by Home and by new tabs. */
  homePage: string;
  /** Search URL with exactly one `%s`. */
  searchTemplate: string;
}

export const SEARCH_ENGINES: Readonly<Record<string, { label: string; template: string }>> = {
  duckduckgo: { label: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  google: { label: 'Google', template: 'https://www.google.com/search?q=%s' },
  bing: { label: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  startpage: { label: 'Startpage', template: 'https://www.startpage.com/do/search?q=%s' },
  wikipedia: { label: 'Wikipedia', template: 'https://en.wikipedia.org/w/index.php?search=%s' },
  archive: { label: 'Internet Archive', template: 'https://archive.org/search?query=%s' },
};

export const DEFAULT_HOME_PAGE = 'anne://pages/home';

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  layout: 'modern',
  keymap: 'default',
  homePage: DEFAULT_HOME_PAGE,
  searchTemplate: SEARCH_ENGINES['duckduckgo']!.template,
};

export interface KnownIds {
  layouts: readonly string[];
  keymaps: readonly string[];
}

const MAX_URL = 2048;

/** A home page may be any page a user could open, but never script or data. */
export function isValidHomePage(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > MAX_URL) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password) return false;
  if (['https:', 'http:', 'gopher:', 'file:'].includes(u.protocol)) return true;
  return u.protocol === 'anne:' && u.host === 'pages';
}

/** A search template must be an HTTPS URL with exactly one `%s` placeholder. */
export function isValidSearchTemplate(t: unknown): t is string {
  if (typeof t !== 'string' || t.length > MAX_URL || t.split('%s').length !== 2) return false;
  try {
    const u = new URL(t.replace('%s', 'test'));
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

export interface ParsedSettings {
  settings: Settings;
  /** Fields that were present but invalid, and fell back to defaults. */
  rejected: string[];
}

export function parseSettings(raw: unknown, known: KnownIds): ParsedSettings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  const rejected: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { settings: out, rejected: raw === undefined ? [] : ['(file)'] };
  const r = raw as Record<string, unknown>;
  const take = <K extends keyof Settings>(key: K, ok: (v: unknown) => boolean) => {
    if (!Object.hasOwn(r, key)) return;
    if (ok(r[key])) out[key] = r[key] as Settings[K];
    else rejected.push(key);
  };
  take('layout', (v) => typeof v === 'string' && known.layouts.includes(v));
  take('keymap', (v) => typeof v === 'string' && known.keymaps.includes(v));
  take('homePage', isValidHomePage);
  take('searchTemplate', isValidSearchTemplate);
  return { settings: out, rejected };
}

export class SettingsError extends Error {
  constructor(message: string) { super(message); this.name = 'SettingsError'; }
}

export class SettingsStore {
  private current: Settings;
  private readonly path: string;
  private readonly known: KnownIds;
  private readonly listeners = new Set<(s: Settings) => void>();
  /** Problems found on load, for the caller to report. */
  readonly loadProblems: string[] = [];

  constructor(path: string, known: KnownIds) {
    this.path = path;
    this.known = known;
    const read = readJson(path);
    if (read.kind === 'corrupt') this.loadProblems.push(`settings file was unreadable and was moved to ${read.movedTo}`);
    const parsed = parseSettings(read.kind === 'ok' ? read.value : undefined, known);
    for (const k of parsed.rejected) this.loadProblems.push(`invalid setting "${k}" was reset to its default`);
    this.current = parsed.settings;
  }

  get(): Settings {
    return { ...this.current };
  }

  /** Validate and apply a change, then write the file. Throws SettingsError and changes nothing if any field is invalid. */
  update(patch: Partial<Omit<Settings, 'version'>>): Settings {
    const merged = { ...this.current, ...patch };
    const { settings, rejected } = parseSettings(merged, this.known);
    if (rejected.length > 0) throw new SettingsError(`invalid setting: ${rejected.join(', ')}`);
    this.current = settings;
    writeJsonAtomic(this.path, this.current);
    for (const l of this.listeners) l(this.get());
    return this.get();
  }

  onDidChange(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
