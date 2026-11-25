import type { Keymap } from '../catalog/types.ts';
import { type Context, WhenCache } from '../when/when.ts';
import { type OS, parseSequence } from './chord.ts';

export interface ResolvedBinding {
  sequence: string[];
  command: string;
  when?: string;
  args?: Record<string, unknown>;
  /** Keymap the binding came from. */
  source: string;
}

export type KeyResult =
  | { kind: 'execute'; command: string; args?: Record<string, unknown> }
  /** A longer binding may follow; the caller should swallow the key and arm a timeout. */
  | { kind: 'pending' }
  | { kind: 'none' };

/** A binding with this command removes earlier bindings for the same keys and scope. */
export const UNBIND = '-';

/**
 * Flatten a keymap and everything it extends into one ordered list. Later
 * entries take priority, so a profile overrides its base and user bindings
 * override both.
 */
export function resolveKeymap(keymaps: readonly Keymap[], id: string, os: OS): ResolvedBinding[] {
  const byId = new Map(keymaps.map((k) => [k.id, k]));
  const chain: Keymap[] = [];
  const seen = new Set<string>();
  for (let cur = byId.get(id); cur; cur = cur.extends ? byId.get(cur.extends) : undefined) {
    if (seen.has(cur.id)) throw new Error(`keymap "${id}" has a circular "extends" chain at "${cur.id}"`);
    seen.add(cur.id);
    chain.unshift(cur);
  }
  if (chain.length === 0) throw new Error(`unknown keymap "${id}"`);
  const out: ResolvedBinding[] = [];
  for (const km of chain) {
    for (const b of km.bindings) {
      const sequence = parseSequence(b.keys, os);
      const same = (o: ResolvedBinding) => o.sequence.join(' ') === sequence.join(' ') && o.when === b.when;
      if (b.command === UNBIND) {
        for (let i = out.length - 1; i >= 0; i--) if (same(out[i]!)) out.splice(i, 1);
        continue;
      }
      out.push({
        sequence, command: b.command, source: km.id,
        ...(b.when !== undefined && { when: b.when }),
        ...(b.args !== undefined && { args: b.args }),
      });
    }
  }
  return out;
}

export interface KeyConflict {
  kind: 'duplicate' | 'prefix';
  keys: string;
  a: ResolvedBinding;
  b: ResolvedBinding;
}

/**
 * Report bindings that collide inside one keymap file: the same keys and
 * scope bound twice (`duplicate`), or one binding being the start of another
 * in the same scope (`prefix`, which delays the shorter one). Bindings that
 * override an inherited keymap are intentional and not reported.
 */
export function findConflicts(bindings: readonly ResolvedBinding[]): KeyConflict[] {
  const out: KeyConflict[] = [];
  for (let i = 0; i < bindings.length; i++) {
    for (let j = i + 1; j < bindings.length; j++) {
      const a = bindings[i]!;
      const b = bindings[j]!;
      if (a.source !== b.source || a.when !== b.when) continue;
      const [short, long] = a.sequence.length <= b.sequence.length ? [a, b] : [b, a];
      if (!short.sequence.every((c, k) => long.sequence[k] === c)) continue;
      out.push({
        kind: short.sequence.length === long.sequence.length ? 'duplicate' : 'prefix',
        keys: long.sequence.join(' '), a, b,
      });
    }
  }
  return out;
}

/**
 * Turns a stream of chords into commands. Holds the pending prefix of a
 * multi-chord binding; the owner calls `timeout()` if no key follows.
 */
export class KeyDispatcher {
  private pending: string[] = [];
  private readonly when = new WhenCache();

  private bindings: readonly ResolvedBinding[];

  constructor(bindings: readonly ResolvedBinding[]) {
    this.bindings = bindings;
  }

  setBindings(bindings: readonly ResolvedBinding[]): void {
    this.bindings = bindings;
    this.pending = [];
  }

  get isPending(): boolean {
    return this.pending.length > 0;
  }

  reset(): void {
    this.pending = [];
  }

  /** Feed one canonical chord. */
  press(chord: string, ctx: Context): KeyResult {
    const hadPrefix = this.pending.length > 0;
    const result = this.match([...this.pending, chord], ctx);
    if (result.kind !== 'none' || !hadPrefix) return result;
    // The prefix led nowhere: it was dropped, so treat this chord as a fresh start.
    return this.match([chord], ctx);
  }

  /** No key followed a pending prefix: run the binding that matches the prefix exactly, if any. */
  timeout(ctx: Context): KeyResult {
    const seq = this.pending;
    this.pending = [];
    const exact = this.candidates(seq, ctx).filter((b) => b.sequence.length === seq.length).at(-1);
    return exact ? toExecute(exact) : { kind: 'none' };
  }

  private candidates(seq: readonly string[], ctx: Context): ResolvedBinding[] {
    return this.bindings.filter(
      (b) => b.sequence.length >= seq.length && seq.every((c, i) => b.sequence[i] === c) && this.when.test(b.when, ctx),
    );
  }

  private match(seq: string[], ctx: Context): KeyResult {
    const candidates = this.candidates(seq, ctx);
    if (candidates.length === 0) { this.pending = []; return { kind: 'none' }; }
    if (candidates.some((b) => b.sequence.length > seq.length)) { this.pending = seq; return { kind: 'pending' }; }
    this.pending = [];
    return toExecute(candidates.at(-1)!);
  }
}

function toExecute(b: ResolvedBinding): KeyResult {
  return { kind: 'execute', command: b.command, ...(b.args !== undefined && { args: b.args }) };
}

/** The shortcut to show beside a command in menus: its highest-priority single-chord binding. */
export function displayBinding(bindings: readonly ResolvedBinding[], command: string): string[] | undefined {
  const mine = bindings.filter((b) => b.command === command && !b.args);
  return (mine.findLast((b) => b.sequence.length === 1) ?? mine.at(-1))?.sequence;
}
