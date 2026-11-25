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
  /** UI -> main: the palette was dismissed. */
  paletteClose: 'anne:palette-close',
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
  paletteOpen: boolean;
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

export function parsePaletteQuery(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length <= 200 ? raw : undefined;
}
