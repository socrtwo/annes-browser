import type { ArgSpec, Capability, Catalog, CommandRecord, Platform } from './catalog/types.ts';
import { type Context, WhenCache } from './when/when.ts';

/** Where an invocation came from. Decides which capabilities it may use. */
export type InvocationSource = 'menu' | 'key' | 'palette' | 'toolbar' | 'internal' | 'macro' | 'extension';

/**
 * Capabilities each source may exercise. Direct user gestures get everything.
 * Macros can be imported from files, so they cannot touch credentials or
 * launch other applications. Extensions get nothing until a per-extension
 * grant model exists.
 */
const SOURCE_GRANTS: Record<InvocationSource, 'all' | readonly Capability[]> = {
  menu: 'all',
  key: 'all',
  palette: 'all',
  toolbar: 'all',
  internal: 'all',
  macro: ['network', 'filesystem', 'clipboard', 'page-script', 'history'],
  extension: [],
};

export type ExecuteFailure =
  | 'unknown' | 'omitted' | 'platform' | 'disabled' | 'forbidden' | 'invalid-args' | 'unimplemented' | 'stub' | 'failed';

export type ExecuteResult = { ok: true } | { ok: false; reason: ExecuteFailure; message: string };

export type CommandArgs = Readonly<Record<string, string | number | boolean>>;

export type Handler<H> = (host: H, args: CommandArgs) => void | Promise<void>;

export interface Invocation<H> {
  source: InvocationSource;
  host: H;
  args?: Readonly<Record<string, unknown>>;
}

export interface RegistryOptions<H> {
  platform: Platform;
  /** Current context for enablement checks, e.g. `{ 'tab.canGoBack': true }`. */
  getContext(host: H): Context;
  /** Called for `stub` commands: show the user why the feature is unavailable. */
  onStub(record: CommandRecord, host: H): void;
  /** Called for commands with no handler yet. */
  onUnimplemented(record: CommandRecord, host: H): void;
  /** Called when a handler throws. */
  onError(record: CommandRecord, error: unknown): void;
}

export interface ExecutedEvent {
  id: string;
  source: InvocationSource;
  args: CommandArgs;
}

const MAX_STRING_ARG = 8192;

function checkArgs(specs: readonly ArgSpec[], raw: Readonly<Record<string, unknown>>): CommandArgs | string {
  const out: Record<string, string | number | boolean> = {};
  const known = new Set(specs.map((s) => s.name));
  for (const name of Object.keys(raw)) if (!known.has(name)) return `unknown argument "${name}"`;
  for (const spec of specs) {
    const v = Object.hasOwn(raw, spec.name) ? raw[spec.name] : undefined;
    if (v === undefined) {
      if (!spec.optional) return `missing argument "${spec.name}"`;
      continue;
    }
    const expected = spec.type === 'url' ? 'string' : spec.type;
    if (typeof v !== expected) return `argument "${spec.name}" must be a ${expected}`;
    if (typeof v === 'string' && v.length > MAX_STRING_ARG) return `argument "${spec.name}" is too long`;
    if (typeof v === 'number' && !Number.isFinite(v)) return `argument "${spec.name}" must be finite`;
    out[spec.name] = v as string | number | boolean;
  }
  return out;
}

/**
 * The single path by which any command runs. Menus, keys, the palette,
 * macros and (later) extensions all call `execute`, so status, platform,
 * enablement, capability and argument checks cannot be bypassed.
 */
export class CommandRegistry<H> {
  private readonly records = new Map<string, CommandRecord>();
  private readonly handlers = new Map<string, Handler<H>>();
  private readonly when = new WhenCache();
  private readonly listeners = new Set<(e: ExecutedEvent) => void>();

  private readonly options: RegistryOptions<H>;

  constructor(catalog: Pick<Catalog, 'commands'>, options: RegistryOptions<H>) {
    this.options = options;
    for (const c of catalog.commands) this.records.set(c.id, c);
  }

  get(id: string): CommandRecord | undefined {
    return this.records.get(id);
  }

  /** Commands that can appear in UI on this platform (everything but `omit`). */
  visible(): CommandRecord[] {
    return [...this.records.values()].filter(
      (c) => c.status !== 'omit' && c.platforms.includes(this.options.platform),
    );
  }

  register(id: string, handler: Handler<H>): void {
    const record = this.records.get(id);
    if (!record) throw new Error(`cannot register handler: "${id}" is not in the catalog`);
    if (record.status === 'stub' || record.status === 'omit') {
      throw new Error(`cannot register handler: "${id}" has status "${record.status}"`);
    }
    if (this.handlers.has(id)) throw new Error(`handler for "${id}" is already registered`);
    this.handlers.set(id, handler);
  }

  hasHandler(id: string): boolean {
    return this.handlers.has(id);
  }

  isEnabled(id: string, ctx: Context): boolean {
    const r = this.records.get(id);
    return !!r && r.status !== 'omit' && this.when.test(r.when, ctx);
  }

  /** Checked state for toggle commands; undefined for commands that are not toggles. */
  isChecked(id: string, ctx: Context): boolean | undefined {
    const r = this.records.get(id);
    return r?.checked === undefined ? undefined : this.when.test(r.checked, ctx);
  }

  onDidExecute(listener: (e: ExecutedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async execute(id: string, inv: Invocation<H>): Promise<ExecuteResult> {
    const fail = (reason: ExecuteFailure, message: string): ExecuteResult => ({ ok: false, reason, message });
    const record = this.records.get(id);
    if (!record) return fail('unknown', `no such command: ${id}`);
    if (record.status === 'omit') return fail('omitted', `${id} is catalogued but not available`);
    if (!record.platforms.includes(this.options.platform)) return fail('platform', `${id} is not available on this platform`);

    const grants = SOURCE_GRANTS[inv.source];
    const denied = grants === 'all' ? undefined : (record.requires ?? []).find((c) => !grants.includes(c));
    if (denied) return fail('forbidden', `${id} needs "${denied}", which a ${inv.source} may not use`);

    const args = checkArgs(record.args ?? [], inv.args ?? {});
    if (typeof args === 'string') return fail('invalid-args', `${id}: ${args}`);

    if (record.status === 'stub') {
      this.options.onStub(record, inv.host);
      return fail('stub', record.status_reason ?? `${record.label} is not available`);
    }
    if (!this.when.test(record.when, this.options.getContext(inv.host))) {
      return fail('disabled', `${record.label} is not available right now`);
    }
    const handler = this.handlers.get(id);
    if (!handler) {
      this.options.onUnimplemented(record, inv.host);
      return fail('unimplemented', `${record.label} is not implemented yet`);
    }
    try {
      await handler(inv.host, args);
    } catch (error) {
      this.options.onError(record, error);
      return fail('failed', `${record.label} failed`);
    }
    for (const l of this.listeners) l({ id, source: inv.source, args });
    return { ok: true };
  }
}
