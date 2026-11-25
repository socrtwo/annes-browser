import { CONTEXT_KEYS } from '../context.ts';
import { isTypingChord, parseSequence } from '../keys/chord.ts';
import { findConflicts, resolveKeymap, UNBIND } from '../keys/resolver.ts';
import { layoutCommandIds } from '../menu/build.ts';
import { parseWhen, whenKeys } from '../when/when.ts';
import type { Catalog } from './types.ts';

export interface Problem {
  level: 'error' | 'warning';
  where: string;
  message: string;
}

/**
 * Cross-reference checks the JSON schema cannot express. A catalog with any
 * `error` must not ship: the runtime assumes these invariants hold.
 */
export function validateCatalog(catalog: Catalog): Problem[] {
  const problems: Problem[] = [];
  const error = (where: string, message: string) => problems.push({ level: 'error', where, message });
  const warn = (where: string, message: string) => problems.push({ level: 'warning', where, message });

  const checkWhen = (where: string, expr: string | undefined): Set<string> => {
    if (expr === undefined) return new Set();
    try {
      const keys = whenKeys(parseWhen(expr));
      for (const k of keys) if (!Object.hasOwn(CONTEXT_KEYS, k)) error(where, `unknown context key "${k}"`);
      return keys;
    } catch (e) {
      error(where, (e as Error).message);
      return new Set();
    }
  };

  const commands = new Map<string, Catalog['commands'][number]>();
  for (const c of catalog.commands) {
    const where = `command ${c.id}`;
    if (commands.has(c.id)) error(where, 'duplicate id');
    commands.set(c.id, c);
    if (c.id.split('.')[0] !== c.category) error(where, `id must start with its category "${c.category}."`);
    if (c.status !== 'implement' && !c.status_reason) error(where, `status "${c.status}" needs a status_reason`);
    if (c.platforms.length === 0) error(where, 'no platforms');
    checkWhen(`${where} when`, c.when);
    checkWhen(`${where} checked`, c.checked);
    const argNames = (c.args ?? []).map((a) => a.name);
    if (new Set(argNames).size !== argNames.length) error(where, 'duplicate argument name');
    let seenOptional = false;
    for (const a of c.args ?? []) {
      if (a.optional) seenOptional = true;
      else if (seenOptional) error(where, `required argument "${a.name}" follows an optional one`);
    }
  }

  const layoutIds = new Set<string>();
  for (const layout of catalog.layouts) {
    const where = `layout ${layout.id}`;
    if (layoutIds.has(layout.id)) error(where, 'duplicate id');
    layoutIds.add(layout.id);
    if (layout.id === 'everything') error(where, '"everything" is generated and cannot be defined');
    for (const id of layoutCommandIds(layout)) {
      const c = commands.get(id);
      if (!c) error(where, `unknown command "${id}"`);
      else if (c.status === 'omit') error(where, `command "${id}" has status "omit" and cannot be in a menu`);
    }
  }

  const keymapIds = new Set(catalog.keymaps.map((k) => k.id));
  if (keymapIds.size !== catalog.keymaps.length) error('keymaps', 'duplicate keymap id');
  for (const km of catalog.keymaps) {
    const where = `keymap ${km.id}`;
    if (km.extends !== undefined && !keymapIds.has(km.extends)) error(where, `extends unknown keymap "${km.extends}"`);
    for (const b of km.bindings) {
      const at = `${where} "${b.keys}"`;
      const whenKeySet = checkWhen(at, b.when);
      for (const os of ['mac', 'other'] as const) {
        try {
          const seq = parseSequence(b.keys, os);
          // Ordinary typing must never trigger a command unless modal mode is on.
          if (isTypingChord(seq[0]!) && !whenKeySet.has('input.modal')) {
            error(at, 'a binding that starts with a plain typing key must be scoped with "input.modal"');
            break;
          }
        } catch (e) {
          error(at, (e as Error).message);
          break;
        }
      }
      if (b.command === UNBIND) continue;
      const c = commands.get(b.command);
      if (!c) { error(at, `unknown command "${b.command}"`); continue; }
      if (c.status === 'omit') error(at, `command "${b.command}" has status "omit"`);
      const specs = new Map((c.args ?? []).map((a) => [a.name, a]));
      for (const [name, v] of Object.entries(b.args ?? {})) {
        const spec = specs.get(name);
        if (!spec) error(at, `command "${b.command}" has no argument "${name}"`);
        else if (typeof v !== (spec.type === 'url' ? 'string' : spec.type)) error(at, `argument "${name}" must be a ${spec.type}`);
      }
      for (const spec of specs.values()) {
        if (!spec.optional && !Object.hasOwn(b.args ?? {}, spec.name)) error(at, `binding does not supply required argument "${spec.name}"`);
      }
    }
    if (problems.some((p) => p.level === 'error' && p.where.startsWith(where))) continue;
    for (const os of ['mac', 'other'] as const) {
      try {
        for (const conflict of findConflicts(resolveKeymap(catalog.keymaps, km.id, os).filter((b) => b.source === km.id))) {
          const text = `${conflict.keys}: ${conflict.a.command} and ${conflict.b.command}`;
          if (conflict.kind === 'duplicate') error(where, `duplicate binding (${os}) ${text}`);
          else warn(where, `prefix overlap (${os}) ${text}; the shorter binding waits for a timeout`);
        }
      } catch (e) {
        error(where, (e as Error).message);
      }
    }
  }
  // De-duplicate messages that repeat for both operating systems.
  const seen = new Set<string>();
  return problems.filter((p) => {
    const k = `${p.level}|${p.where}|${p.message.replace(/\((mac|other)\) /, '')}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}
