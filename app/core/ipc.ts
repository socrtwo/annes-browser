/**
 * The contract between the browser UI (a sandboxed renderer) and the main
 * process. The UI is treated as untrusted input: every message is checked
 * here before the main process acts on it. Keep this surface small. The UI
 * can ask for a command to run; it cannot reach files, sessions or tabs
 * directly.
 */

export const IPC = {
  /** UI -> main, request/response: run a catalog command. */
  execute: 'anne:execute',
  /** UI -> main, request/response: search the command palette. */
  paletteSearch: 'anne:palette-search',
  /** UI -> main: the UI has loaded and wants the current state. */
  ready: 'anne:ready',
  /** UI -> main, request/response: items for a list panel (bookmarks, history, downloads). */
  list: 'anne:list',
  /** UI -> main: the palette or panel was dismissed. */
  closeOverlay: 'anne:close-overlay',
  /** main -> UI: the current window state. */
  state: 'anne:state',
} as const;

/** Sources the UI may claim for an invocation. It can never claim `internal`. */
export type UiSource = 'toolbar' | 'palette';

export interface ExecuteRequest {
  id: string;
  source: UiSource;
  args?: Record<string, string | number | boolean>;
}

/** Full-window overlays drawn by the UI. */
export type Overlay = 'palette' | 'bookmarks' | 'history' | 'downloads';
export const LIST_KINDS = ['bookmarks', 'history', 'downloads'] as const;
export type ListKind = (typeof LIST_KINDS)[number];

/** One row in a list panel. Every string is display text; the UI never parses it. */
export interface ListItem {
  id: number;
  title: string;
  /** Address shown under the title. */
  url: string;
  /** Extra text: visit date, download progress. */
  detail: string;
  /** Command run when the row is chosen, with `{ id }` as its argument. */
  open?: string;
  /** Command run by the row's remove button, with `{ id }`. */
  remove?: string;
  /** Command run by the row's secondary button, with `{ id }`, and its label. */
  secondary?: { command: string; label: string };
}

export interface FindState {
  /** Matches on the page; undefined until the first result arrives. */
  matches?: number;
  /** 1-based index of the highlighted match. */
  active?: number;
}

export interface TabState {
  id: number;
  title: string;
  active: boolean;
  loading: boolean;
}

export interface WindowState {
  tabs: TabState[];
  /** Address-bar text for the active tab. */
  address: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  overlay?: Overlay;
  /** Present while the find bar is open. */
  find?: FindState;
  /** Incremented each time the find field should take focus. */
  focusFind: number;
  /** Incremented whenever list data (bookmarks, history, downloads) changes. */
  listVersion: number;
  isPrivate: boolean;
  isBookmarked: boolean;
  modal: boolean;
  /** Incremented each time the address bar should take focus. */
  focusAddress: number;
  /** A one-line message for the user, if any. */
  notice?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const COMMAND_ID = /^[a-z]+(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;

/** Validate an execute request from the UI. Returns undefined if it is malformed. */
export function parseExecuteRequest(raw: unknown): ExecuteRequest | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, source, args, ...rest } = raw;
  if (Object.keys(rest).length > 0) return undefined;
  if (typeof id !== 'string' || id.length > 80 || !COMMAND_ID.test(id)) return undefined;
  if (source !== 'toolbar' && source !== 'palette') return undefined;
  if (args === undefined) return { id, source };
  if (!isRecord(args) || Object.keys(args).length > 8) return undefined;
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!/^[a-z][A-Za-z0-9]{0,31}$/.test(k)) return undefined;
    if (typeof v === 'string' ? v.length > 8192 : typeof v === 'number' ? !Number.isFinite(v) : typeof v !== 'boolean') return undefined;
    clean[k] = v as string | number | boolean;
  }
  return { id, source, args: clean };
}

export function parseListRequest(raw: unknown): { kind: ListKind; query: string } | undefined {
  if (!isRecord(raw)) return undefined;
  const { kind, query, ...rest } = raw;
  if (Object.keys(rest).length > 0) return undefined;
  if (typeof kind !== 'string' || !(LIST_KINDS as readonly string[]).includes(kind)) return undefined;
  if (typeof query !== 'string' || query.length > 200) return undefined;
  return { kind: kind as ListKind, query };
}

export function parsePaletteQuery(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length <= 200 ? raw : undefined;
}
