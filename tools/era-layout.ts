/**
 * Generate an era layout from a browser's real menus in the census.
 *
 *   node tools/era-layout.ts <source-id> <layout-id> "<label>" "<description>" [<menu root>]
 *
 * Reads the source's text (a dump in rc syntax, or a transcription) in its original order, with
 * submenus and separators, and keeps every entry linked to a command: under the browser's own
 * wording when it differs from the command's label. Entries with no command are left out, so the
 * layout shows what Anne's Browser can offer in that arrangement, never an invented item.
 *
 * <menu root> picks the menu resource(s) in a dump with several (e.g. "menu #2", "browselc menu #267"); a comma-separated
 * list joins several, in order, for browsers that assemble their menu bar at run time from one resource per menu (IE 7+).
 * The result is written to catalog/layouts/<layout-id>.yaml with a header naming its source.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { LayoutItem, MenuLayout } from '../app/core/catalog/types.ts';
import { loadCatalog } from './build-catalog.ts';
import { loadAllCensus } from './census-load.ts';
import { loadNames, loadOverrides, matchCensus } from './census/merge.ts';
import { loadSources, readLocal } from './census/run.ts';

export interface Entry { path: string[]; kind: 'item' | 'separator'; key?: string; label?: string }

/** Original wording: no accelerator marker, no shortcut after a tab. Ellipses are kept, as the menus had them. */
export const originalLabel = (s: string) => s.replace(/(\\t|\t).*$/, '').replace(/&(?!&)/g, '').replace(/&&/g, '&').trim();

/** rc-syntax dumps: one entry list per MENU resource, named like the extractor names it (`menu #2`). */
export function readRc(text: string): Map<string, Entry[]> {
  const out = new Map<string, Entry[]>();
  let root = '';
  let entries: Entry[] = [];
  const stack: string[] = [];
  let pending: string | undefined;
  for (const l of text.split(/\r?\n/)) {
    const head = /^\s*(\w+)\s+MENU(EX)?\b/.exec(l);
    if (head) {
      const n = /^MENU_(?:_(\w+?)_)?_(\d+)$/.exec(head[1]!);
      root = n ? `${n[1] ? `${n[1]} ` : ''}menu #${n[2]}` : head[1]!;
      entries = [];
      out.set(root, entries);
      stack.length = 0;
      continue;
    }
    const popup = /^\s*POPUP\s+"([^"]*)"/.exec(l);
    if (popup) { pending = originalLabel(popup[1]!); continue; }
    if (/^\s*(\{|BEGIN)\s*$/.test(l)) { if (pending !== undefined) { stack.push(pending); pending = undefined; } else stack.push(''); continue; }
    if (/^\s*(\}|END)\s*$/.test(l)) { stack.pop(); continue; }
    const path = stack.filter(Boolean);
    if (/^\s*MENUITEM\s+SEPARATOR/.test(l)) { entries.push({ path, kind: 'separator' }); continue; }
    const mi = /^\s*MENUITEM\s+"([^"]+)"\s*,\s*(\w+)/.exec(l);
    if (mi) entries.push({ path, kind: 'item', key: mi[2]!, label: originalLabel(mi[1]!.replace(/\\t.*$/, '')) });
  }
  return out;
}

/** Transcriptions (`path | label | shortcut`): no separators are recorded. */
export function readTranscription(text: string): Entry[] {
  const out: Entry[] = [];
  for (const l of text.split(/\r?\n/)) {
    if (l.startsWith('#') || !l.trim()) continue;
    const m = /^([^|]+?)\s*\|\s*([^|]+?)\s*(?:\|.*)?$/.exec(l);
    if (m) out.push({ path: m[1]!.split(' > ').map((s) => s.trim()), kind: 'item', key: `${m[1]}/${m[2]}`, label: m[2]! });
  }
  return out;
}

/**
 * Entries to layout menus. `command(key)` gives the linked command id, or undefined.
 * `usable(id)` says whether the command may appear in a menu. A command appears once per menu.
 */
export function toMenus(entries: readonly Entry[], command: (key: string) => string | undefined, usable: (id: string) => string | undefined): MenuLayout['menus'] {
  interface Node { label: string; items: (LayoutItem | Node)[]; seen: Set<string>; linked: number }
  const top: Node[] = [];
  const find = (list: (LayoutItem | Node)[], label: string): Node => {
    let n = list.find((x): x is Node => typeof x === 'object' && 'seen' in x && x.label === label);
    if (!n) { n = { label, items: [], seen: new Set(), linked: 0 }; list.push(n); }
    return n;
  };
  for (const e of entries) {
    if (e.path.length === 0) continue;
    let node = find(top as (LayoutItem | Node)[], e.path[0]!);
    for (const p of e.path.slice(1)) node = find(node.items, p);
    if (e.kind === 'separator') { node.items.push({ separator: true }); continue; }
    const id = command(e.key!);
    if (!id) continue;
    const ownLabel = usable(id);
    if (ownLabel === undefined) continue;
    node.linked++;
    if (node.seen.has(id)) continue;
    node.seen.add(id);
    node.items.push(e.label && e.label !== ownLabel ? { command: id, label: e.label } : id);
  }
  const finish = (items: (LayoutItem | Node)[]): LayoutItem[] => {
    const out: LayoutItem[] = [];
    for (const i of items) {
      const v: LayoutItem | undefined = typeof i === 'object' && 'seen' in i
        ? (() => {
          // A submenu whose entries are all one command (a list of text encodings, of window positions)
          // becomes that command, named as the submenu was.
          const only = i.seen.size === 1 && i.linked > 1 && i.items.every((x) => typeof x !== 'object' || !('seen' in x)) ? [...i.seen][0]! : undefined;
          if (only) return { command: only, label: i.label };
          const sub = finish(i.items);
          return sub.length ? { label: i.label, items: sub } : undefined;
        })()
        : i;
      if (!v) continue;
      if (typeof v === 'object' && 'separator' in v && (out.length === 0 || (typeof out.at(-1) === 'object' && 'separator' in (out.at(-1) as object)))) continue;
      out.push(v);
    }
    while (out.length && typeof out.at(-1) === 'object' && 'separator' in (out.at(-1) as object)) out.pop();
    return out;
  };
  return top.map((m) => ({ label: m.label, items: finish(m.items) })).filter((m) => m.items.length > 0);
}

if (import.meta.main) {
  const [sourceId, layoutId, label, description, rootName] = process.argv.slice(2);
  if (!sourceId || !layoutId || !label || !description) {
    console.error('usage: node tools/era-layout.ts <source-id> <layout-id> "<label>" "<description>" [<menu root>]');
    process.exit(2);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(layoutId)) throw new Error(`bad layout id: ${layoutId}`);
  const spec = loadSources().find((s) => s.id === sourceId);
  if (!spec) throw new Error(`no source ${sourceId}`);
  if (!['dump', 'machine', 'local'].includes(spec.host ?? '')) throw new Error('only dumped or transcribed sources keep menu order');
  const text = readLocal(spec.files[0]!.path);

  let entries: Entry[];
  if (spec.extractor === 'rc-menu') {
    const all = readRc(text);
    const keys = (rootName ?? [...all.keys()][0]!).split(',').map((s) => s.trim());
    for (const k of keys) if (!all.has(k)) throw new Error(`no menu "${k}"; have: ${[...all.keys()].join(', ')}`);
    entries = keys.flatMap((k) => all.get(k)!);
  } else entries = readTranscription(text);

  const catalog = loadCatalog();
  const commands = new Map(catalog.commands.map((c) => [c.id, c]));
  const result = matchCensus(loadAllCensus(), loadNames(), loadOverrides(), new Set(commands.keys()));
  const linked = new Map(result.matches.filter((m) => m.source.id === sourceId).map((m) => [m.item.key, m.command]));
  const usable = (id: string) => {
    const c = commands.get(id);
    if (!c || c.status === 'omit' || (c.args ?? []).some((a) => !a.optional)) return undefined;
    return c.label;
  };
  const menus = toMenus(entries, (k) => linked.get(k), usable);
  const layout: MenuLayout = { id: layoutId, label, description, menus };
  const count = (items: LayoutItem[]): number => items.reduce((n, i) => n + (typeof i === 'string' || 'command' in i ? 1 : 'items' in i ? count(i.items) : 0), 0);
  const header = [
    `# Generated by tools/era-layout.ts from census source ${sourceId}${rootName ? ` (${rootName})` : ''}: ${spec.browser} ${spec.version}.`,
    '# Order, submenus, separators and wording are the browser\'s own; entries with no command in the catalog are left out.',
    '# Regenerate rather than edit.',
  ];
  writeFileSync(join(import.meta.dirname, '..', 'catalog', 'layouts', `${layoutId}.yaml`), `${header.join('\n')}\n${stringify(layout, { lineWidth: 0 })}`);
  console.log(`${layoutId}: ${menus.length} menus, ${menus.reduce((n, m) => n + count(m.items), 0)} commands (of ${entries.filter((e) => e.kind === 'item').length} entries)`);
}
