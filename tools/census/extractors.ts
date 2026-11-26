import type { CensusItem, Extractor, ExtractorId, Files, SourceSpec } from './types.ts';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const lines = (text: string) => text.split(/\r?\n/);
const primary = (files: Files, spec: SourceSpec): string => {
  const p = spec.files.find((f) => f.role === 'primary')!.path;
  return files[p] ?? '';
};
const labelsText = (files: Files, spec: SourceSpec): string =>
  spec.files.filter((f) => f.role === 'labels').map((f) => files[f.path] ?? '').join('\n');

/** Remove accelerator markers (`&File`, `_File`, `(&F)`) and trailing ellipses from a label. */
export function cleanLabel(raw: string): string {
  return raw
    .replace(/\\n|\\t/g, ' ')
    .replace(/\(&[A-Za-z0-9]\)/g, '')
    .replace(/&&/g, '\u0000')
    .replace(/&(?=\S)/g, '')
    .replace(/\u0000/g, '&')
    .replace(/_(?=[A-Za-z])/g, '')
    .replace(/\s*(\.\.\.|…)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const item = (i: Omit<CensusItem, 'evidence'> & { text: string }): CensusItem => {
  const { text, ...rest } = i;
  return { ...rest, evidence: clip(text.trim(), 120) };
};

/** Collapse each `a > b` menu path and drop empty parts. */
const path = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' > ');

// ---------------------------------------------------------------- Mosaic (Motif C macros)

const mosaicMenu: Extractor = (files, spec) => {
  const out: CensusItem[] = [];
  const src = lines(primary(files, spec));
  // First pass: which menu title each menuspec belongs to, from the lines that attach submenus.
  const titleOf = new Map<string, string>();
  src.forEach((l) => {
    const m = /DEFINE_MENUBAR\("([^"]+)"\s*,\s*"[^"]*"\s*,\s*NULL\s*,\s*0\s*,\s*(\w+_menuspec)\)/.exec(l);
    if (m) titleOf.set(m[2]!, m[1]!);
  });
  let current = '';
  src.forEach((l, i) => {
    const alloc = /ALLOC_MENUBAR\((\w+),/.exec(l);
    if (alloc) current = alloc[1]!;
    const m = /^\s*DEFINE_MENUBAR\("([^"]+)"\s*,\s*"([^"]*)"\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*NULL\)/.exec(l);
    if (!m || !current) return;
    const [, label, , cb, id] = m as unknown as [string, string, string, string, string];
    if (cb === 'NULL') return;
    const menu = titleOf.get(current) ?? current.replace(/_menuspec$/, '');
    out.push(item({ key: id, label: cleanLabel(label), menu, line: i + 1, text: l }));
  });
  return out;
};

// ---------------------------------------------------------------- Lynx

const lynxKeymap: Extractor = (files, spec) => {
  const src = lines(primary(files, spec));
  const out: CensusItem[] = [];
  const seen = new Set<string>();
  const add = (key: string, desc: string, line: number, text: string) => {
    if (key === 'UNMAPPED' || seen.has(key)) return;
    seen.add(key);
    out.push(item({ key, note: clip(desc.replace(/\s+/g, ' ').trim(), 100), line, text }));
  };
  // Table rows inside `#ifdef NOT_USED` are compiled out: they are not commands.
  let disabled = 0;
  src.forEach((l, i) => {
    if (/^\s*#\s*if/.test(l)) disabled = disabled > 0 || /^\s*#\s*ifdef\s+NOT_USED\b/.test(l) ? disabled + 1 : 0;
    else if (/^\s*#\s*endif/.test(l) && disabled > 0) disabled--;
    if (disabled > 0) return;
    // 2.7/2.8: { "NAME",\t\t"description" },
    const old = /^\s*\{\s*"([A-Z0-9_]+)"\s*,\s*"([^"]*)"\s*\}/.exec(l);
    if (old) return add(old[1]!, old[2]!, i + 1, l);
    // Current: DATA(\n LYK_X, "X",\n "description"),
    const cur = /^\s*LYK_\w+,\s*"([A-Z0-9_]+)",\s*$/.exec(l);
    if (cur) {
      const desc = /^\s*"([^"]*)"/.exec(src[i + 1] ?? '');
      if (desc) add(cur[1]!, desc[1]!, i + 1, l);
    }
  });
  return out;
};

// ---------------------------------------------------------------- w3m

const w3mFunc: Extractor = (files, spec) => {
  const out: CensusItem[] = [];
  lines(primary(files, spec)).forEach((l, i) => {
    const m = /^([A-Z][A-Z0-9_]+)\s+(\S.*)$/.exec(l);
    if (m) out.push(item({ key: m[1]!, note: clip(m[2]!.trim(), 100), line: i + 1, text: l }));
  });
  return out;
};

// ---------------------------------------------------------------- ELinks

const elinksActions: Extractor = (files, spec) => {
  const out: CensusItem[] = [];
  for (const f of spec.files) {
    lines(files[f.path] ?? '').forEach((l, i) => {
      const m = /^ACTION_\((\w+),\s*"([^"]+)",\s*\w+,\s*(?:N__\("([^"]*)"\)|NULL)/.exec(l);
      if (!m || m[2]!.startsWith(' ') || m[2] === 'none') return;
      out.push(item({
        key: `${m[1]!.toLowerCase()}:${m[2]}`, group: m[1]!.toLowerCase(),
        ...(m[3] ? { note: clip(m[3], 100) } : {}), line: i + 1, text: l,
        ...(f.path !== spec.files[0]!.path && { file: f.path }),
      }));
    });
  }
  return out;
};

// ---------------------------------------------------------------- Chromium / Brave command ids

const chromiumIds: Extractor = (files, spec) => {
  const out: CensusItem[] = [];
  let group = '';
  lines(primary(files, spec)).forEach((l, i) => {
    const c = /^\/\/\s*(.+?)\s*$/.exec(l);
    // Section comments look like "// Navigation commands" or "// Page-related commands".
    if (c && /\b(commands?|menu|menus|items?)\b/i.test(c[1]!) && !/NOTE|TODO|Note:/.test(c[1]!)) group = c[1]!.replace(/\.$/, '');
    const m = /^#define\s+(IDC_\w+)\s+(\d+)/.exec(l);
    if (m) out.push(item({ key: m[1]!, ...(group && { group }), line: i + 1, text: l }));
  });
  return out;
};

// ---------------------------------------------------------------- Dillo (FLTK, C++)

const dilloMenu: Extractor = (files, spec) => {
  const out: CensusItem[] = [];
  const seen = new Set<string>();
  lines(primary(files, spec)).forEach((l, i) => {
    const m = /^\s*\{"([^"]+)"\s*,/.exec(l) ?? /\bnew Item\("([^"]+)"\)/.exec(l);
    if (!m) return;
    const label = cleanLabel(m[1]!);
    if (seen.has(label.toLowerCase())) return;
    seen.add(label.toLowerCase());
    out.push(item({ key: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label, menu: 'Context menu', line: i + 1, text: l }));
  });
  return out;
};

// ---------------------------------------------------------------- XUL (SeaMonkey)

function parseDtd(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of text.matchAll(/<!ENTITY\s+([\w.\-]+)\s+"([^"]*)"\s*>/g)) map.set(m[1]!, m[2]!);
  return map;
}
const resolveEntities = (s: string, dtd: Map<string, string>): string | undefined => {
  let unresolved = false;
  const out = s.replace(/&([\w.\-]+);/g, (_m, name: string) => {
    const v = dtd.get(name);
    if (v === undefined) { unresolved = true; return ''; }
    return v;
  });
  return unresolved ? undefined : out;
};

const xulMenu: Extractor = (files, spec) => {
  const dtd = parseDtd(labelsText(files, spec));
  const src = lines(primary(files, spec));
  // Labels are often on a <command> or <broadcaster> rather than on the menu item that uses it.
  const commandLabels = new Map<string, string>();
  src.forEach((l, i) => {
    const d = /<(?:command|broadcaster|menuitem)\s[^>]*?\bid="([^"]+)"/.exec(l);
    if (!d) return;
    let tag = l;
    for (let j = i + 1; !/>/.test(tag) && j < src.length && j - i < 6; j++) tag += ` ${src[j]!.trim()}`;
    const lab = /\blabel="([^"]*)"/.exec(tag)?.[1];
    const r = lab === undefined ? undefined : resolveEntities(lab, dtd);
    if (r !== undefined) commandLabels.set(d[1]!, r);
  });
  const out: CensusItem[] = [];
  const stack: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const open = /^\s*<(menu|menuitem)\b/.exec(src[i]!);
    if (/^\s*<\/menu>/.test(src[i]!)) { stack.pop(); continue; }
    if (!open) continue;
    let tag = src[i]!;
    for (let j = i + 1; !/>/.test(tag) && j < src.length && j - i < 6; j++) tag += ` ${src[j]!.trim()}`;
    const attr = (n: string) => new RegExp(`\\b${n}="([^"]*)"`).exec(tag)?.[1];
    const id = attr('id');
    const command = attr('command');
    const rawLabel = attr('label');
    const label = rawLabel !== undefined ? resolveEntities(rawLabel, dtd) : (command && commandLabels.get(command)) || (id && commandLabels.get(id)) || undefined;
    if (open[1] === 'menu') {
      // A self-closing <menu/> has no body and no closing tag.
      if (!/\/>\s*$/.test(tag)) stack.push(cleanLabel(label ?? ''));
      continue;
    }
    const key = id ?? command ?? (rawLabel ? rawLabel.replace(/[&;]/g, '') : '');
    if (!key || /class="[^"]*(bookmark-item|bookmark-group|isempty)/.test(tag)) continue;
    const menu = path(...stack);
    out.push(item({
      key, ...(label ? { label: cleanLabel(label) } : {}), ...(menu && { menu }),
      ...(attr('key') && { shortcut: `key:${attr('key')}` }), line: i + 1, text: src[i]!,
    }));
  }
  return out;
};

// ---------------------------------------------------------------- Firefox (XUL include + Fluent labels)

const firefoxMenu: Extractor = (files, spec) => {
  const ftl = new Map<string, string>();
  let current = '';
  for (const l of lines(labelsText(files, spec))) {
    const head = /^([a-z][\w-]*)\s*=\s*(.*)$/.exec(l);
    if (head) { current = head[1]!; if (head[2]!.trim()) ftl.set(`${current}`, head[2]!.trim()); continue; }
    const attr = /^\s+\.label\s*=\s*(.+)$/.exec(l);
    if (attr && current) ftl.set(`${current}.label`, attr[1]!.trim());
  }
  const out: CensusItem[] = [];
  const stack: { name: string; line: number }[] = [];
  const src = lines(primary(files, spec));
  const depthOf: number[] = [];
  src.forEach((l, i) => {
    const open = /^\s*<(menu|menuitem)\b/.exec(l);
    if (open) {
      let tag = l;
      for (let j = i + 1; !/>/.test(tag) && j < src.length && j - i < 8; j++) tag += ` ${src[j]!.trim()}`;
      const id = /\bid="([^"]+)"/.exec(tag)?.[1];
      const l10n = /data-l10n-id="([^"]+)"/.exec(tag)?.[1];
      const label = l10n ? (ftl.get(`${l10n}.label`) ?? ftl.get(l10n)) : /\blabel="([^"]+)"/.exec(tag)?.[1];
      if (open[1] === 'menu') { stack.push({ name: cleanLabel(label ?? id ?? ''), line: i }); depthOf.push(i); return; }
      const key = id ?? l10n;
      if (key) {
        out.push(item({
          key, ...(label && { label: cleanLabel(label) }), ...(stack.length && { menu: path(...stack.map((s) => s.name)) }),
          line: i + 1, text: l,
        }));
      }
    }
    if (/^\s*<\/menu>/.test(l)) stack.pop();
  });
  return out;
};

// ---------------------------------------------------------------- Falkon

const falkonActions: Extractor = (files, spec) => {
  const out: CensusItem[] = [];
  lines(primary(files, spec)).forEach((l, i) => {
    const m = /ADD_(?:CHECKABLE_)?ACTION\("([^"]+)"/.exec(l);
    if (!m) return;
    const label = /\btr\("([^"]+)"\)/.exec(l)?.[1];
    // The shortcut is the quoted string after the SLOT(...) argument, if any.
    const shortcut = /SLOT\((?:[^()]|\([^()]*\))*\)\s*,\s*"([^"]*)"/.exec(l)?.[1];
    const [menu] = m[1]!.split('/');
    out.push(item({
      key: m[1]!, ...(label && { label: cleanLabel(label) }), ...(menu && { menu }), ...(shortcut && { shortcut }), line: i + 1, text: l,
    }));
  });
  return out;
};

// ---------------------------------------------------------------- Qt (Ladybird): menu bar built in code

const qtActions: Extractor = (files, spec) => {
  const out: CensusItem[] = [];
  const menus = new Map<string, string>(); // variable -> full menu path
  const seen = new Set<string>();
  lines(primary(files, spec)).forEach((l, i) => {
    const menu = /\bauto\*\s+(\w+)\s*=\s*(\w+)->addMenu\("([^"]+)"\)/.exec(l);
    if (menu) {
      const parent = menus.get(menu[2]!);
      menus.set(menu[1]!, path(parent, cleanLabel(menu[3]!)));
      return;
    }
    const act = /\b(\w+)->addAction\((?:create_application_action\(\*?\w+,\s*application\.)?(\w+?)(?:_action)?\(\)/.exec(l);
    if (!act || !menus.has(act[1]!)) return;
    const key = act[2]!;
    const where = menus.get(act[1]!)!;
    if (seen.has(`${where}|${key}`)) return;
    seen.add(`${where}|${key}`);
    out.push(item({ key: `${where}:${key}`, menu: where, line: i + 1, text: l }));
  });
  return out;
};

// ---------------------------------------------------------------- Qt Designer .ui (early Otter)

const qtUi: Extractor = (files, spec) => {
  const out: CensusItem[] = [];
  const src = lines(primary(files, spec));
  src.forEach((l, i) => {
    const m = /<action name="(\w+)">/.exec(l);
    if (!m) return;
    let text: string | undefined;
    for (let j = i + 1; j < Math.min(i + 12, src.length) && !/<\/action>/.test(src[j]!); j++) {
      const t = /<property name="text">/.test(src[j]!) ? /<string[^>]*>([^<]*)<\/string>/.exec(src[j + 1] ?? '') : null;
      if (t) { text = t[1]; break; }
    }
    out.push(item({ key: m[1]!, ...(text && { label: cleanLabel(text) }), line: i + 1, text: l }));
  });
  return out;
};

// ---------------------------------------------------------------- Otter

const otterEnum: Extractor = (files, spec) => {
  const out: CensusItem[] = [];
  let inEnum = false;
  lines(primary(files, spec)).forEach((l, i) => {
    if (/enum ActionIdentifier/.test(l)) { inEnum = true; return; }
    if (inEnum && /^\s*\};?/.test(l)) { inEnum = false; return; }
    const m = inEnum ? /^\s*(\w+Action)\b/.exec(l) : null;
    if (m) out.push(item({ key: m[1]!, line: i + 1, text: l }));
  });
  return out;
};

// ---------------------------------------------------------------- Vimium / qutebrowser

const vimiumCommands: Extractor = (files, spec) => {
  const src = lines(primary(files, spec));
  const out: CensusItem[] = [];
  src.forEach((l, i) => {
    const name = /^\s*name:\s*"([^"]+)"/.exec(l);
    if (!name) return;
    let desc: string | undefined;
    let group: string | undefined;
    for (let j = i + 1; j < Math.min(i + 8, src.length) && !/^\s*name:/.test(src[j]!); j++) {
      desc ??= /^\s*desc:\s*"([^"]*)"/.exec(src[j]!)?.[1];
      group ??= /^\s*group:\s*"([^"]*)"/.exec(src[j]!)?.[1];
    }
    out.push(item({ key: name[1]!, ...(desc && { note: clip(desc, 100) }), ...(group && { group }), line: i + 1, text: l }));
  });
  return out;
};

const qutebrowserCommands: Extractor = (files, spec) => {
  const src = lines(primary(files, spec));
  const out: CensusItem[] = [];
  src.forEach((l, i) => {
    const m = /^\[\[([a-z0-9\-]+)\]\]\s*$/.exec(l);
    if (!m || !/^=== /.test(src[i + 1] ?? '')) return;
    // The description is the first prose line after the "Syntax:" line.
    let desc: string | undefined;
    for (let j = i + 2; j < Math.min(i + 12, src.length); j++) {
      const t = src[j]!.trim();
      if (!t || t.startsWith('Syntax:') || t.startsWith('=') || t.startsWith('[[')) continue;
      desc = t.replace(/[+*`]/g, '');
      break;
    }
    out.push(item({ key: m[1]!, ...(desc && { note: clip(desc, 100) }), line: i + 1, text: l }));
  });
  return out;
};

// ---------------------------------------------------------------- Konqueror (KDE XMLGUI)

const konquerorRc: Extractor = (files, spec) => {
  const out: CensusItem[] = [];
  let menu = '';
  let inMenuBar = false;
  lines(primary(files, spec)).forEach((l, i) => {
    // Toolbars and context menus list actions too; only the menu bar is a menu.
    if (/<MenuBar>/.test(l)) inMenuBar = true;
    if (/<\/MenuBar>/.test(l)) inMenuBar = false;
    if (!inMenuBar) return;
    const m = /<Menu\s+name="[^"]*"[^>]*><text>([^<]+)<\/text>/.exec(l);
    if (m) menu = cleanLabel(m[1]!.replace(/&amp;/g, '&'));
    const a = /<Action\s+name="([^"]+)"/.exec(l);
    if (a) out.push(item({ key: a[1]!, ...(menu && { menu }), line: i + 1, text: l }));
  });
  return out;
};

// ---------------------------------------------------------------- Scanned manuals (OCR prose)

/** Menus a browser manual of the 1990s may name. Anything else after "the ... menu" is ignored. */
const MANUAL_MENUS = new Set(['File', 'Edit', 'View', 'Go', 'Bookmarks', 'Options', 'Directory', 'Window', 'Help', 'Communicator', 'Favorites', 'Tools']);
// A command name: capitalized words, allowing small joining words inside ("Add to Bookmarks", "Save As").
const NAME = "[A-Z][A-Za-z']*(?: (?:[A-Z][A-Za-z']*|as|to|in|of|and|the|a|on|by))*";
const PHRASES = [
  new RegExp(`\\b[Ff]rom the (\\w+) menu,? (?:choose|select|pick|click(?: on)?) (${NAME})`, 'g'),
  new RegExp(`\\b(?:[Cc]hoose|[Ss]elect|[Pp]ick|[Uu]se) (${NAME}) (?:from|on|in|under) the (\\w+) menu`, 'g'),
  new RegExp(`\\b[Oo]pen the (\\w+) menu and (?:choose|select) (${NAME})`, 'g'),
];
// Words a sentence may continue with after the command name; a trailing one is not part of the name.
const TRAILING = /(?: (?:as|to|in|of|and|the|a|on|by))+$/;

/**
 * Menu commands named in a manual's prose: "From the File menu, choose Open Location". Only these
 * fixed phrasings are read, so the result is what the manual states outright, not an inference.
 * It is a sample of the menus, not a full listing: a command the author never walks through is absent.
 */
const manualPhrases: Extractor = (files, spec) => {
  const src = lines(primary(files, spec));
  const out: CensusItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < src.length; i++) {
    // Sentences wrap: read each line together with the start of the next, but cite the line the phrase starts on.
    const here = src[i]!;
    const joined = `${here.trimEnd()} ${(src[i + 1] ?? '').trim()}`;
    for (const [n, re] of PHRASES.entries()) {
      re.lastIndex = 0;
      for (let m = re.exec(joined); m; m = re.exec(joined)) {
        if (m.index >= here.trimEnd().length) continue; // starts on the next line; it will be read there
        const menu = n === 1 ? m[2]! : m[1]!;
        const label = (n === 1 ? m[1]! : m[2]!).replace(TRAILING, '');
        if (!MANUAL_MENUS.has(menu) || label.length < 2 || label.length > 40) continue;
        const key = `${menu}/${label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item({ key, label, menu, line: i + 1, text: here }));
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------- Screenshot transcriptions

/** Lines `<where> | <label>`; `#` lines are the header (image address, hash, who read it). */
const transcription: Extractor = (files, spec) => {
  const out: CensusItem[] = [];
  lines(primary(files, spec)).forEach((l, i) => {
    if (l.startsWith('#') || !l.trim()) return;
    const m = /^([^|]+?)\s*\|\s*(.+?)\s*$/.exec(l);
    if (!m) return;
    out.push(item({ key: `${m[1]}/${m[2]}`, label: m[2]!, menu: m[1]!, line: i + 1, text: l }));
  });
  return out;
};

// ---------------------------------------------------------------- Windows resource scripts (.rc MENU)

/** `POPUP "&File" { MENUITEM "&Open...", ID_OPEN ... }`, with BEGIN/END or braces. */
const rcMenu: Extractor = (files, spec) => {
  const out: CensusItem[] = [];
  const stack: string[] = [];
  let pending: string | undefined;
  let inMenu = false;
  /** Dumps from binaries (tools/pe-dump.ts) name menus by resource number; keep it so different windows' menus stay apart. */
  let root: string | undefined;
  lines(primary(files, spec)).forEach((l, i) => {
    const head = /^\s*(\w+)\s+MENU(EX)?\b/.exec(l);
    if (head) { inMenu = true; stack.length = 0; const n = /^MENU_(?:_(\w+?)_)?_(\d+)$/.exec(head[1]!); root = n ? `${n[1] ? `${n[1]} ` : ''}menu #${n[2]}` : undefined; return; }
    if (!inMenu) return;
    const popup = /^\s*POPUP\s+"([^"]+)"/.exec(l);
    if (popup) { pending = cleanLabel(popup[1]!); return; }
    if (/^\s*(\{|BEGIN)\s*$/.test(l)) { if (pending !== undefined) { stack.push(pending); pending = undefined; } else if (stack.length === 0) stack.push(''); return; }
    if (/^\s*(\}|END)\s*$/.test(l)) { stack.pop(); if (stack.length === 0) inMenu = false; return; }
    const mi = /^\s*MENUITEM\s+"([^"]+)"\s*,\s*(\w+)/.exec(l);
    if (mi) out.push(item({ key: mi[2]!, label: cleanLabel(mi[1]!.replace(/(?:\\t|\t).*$/, '')), menu: path(root, ...stack.filter(Boolean)), line: i + 1, text: l }));
  });
  return out;
};

// ---------------------------------------------------------------- WebKit localized context-menu strings

/** `- (NSString *)contextMenuItemTagX` (2010, Objective-C) or `String contextMenuItemTagX()` (C++), then the first string. */
const webkitStrings: Extractor = (files, spec) => {
  const out: CensusItem[] = [];
  const src = lines(primary(files, spec));
  src.forEach((l, i) => {
    const m = /(?:NSString \*\)|^String )(contextMenuItemTag\w+)\s*(?:\(|$)/.exec(l);
    if (!m) return;
    for (let j = i + 1; j < Math.min(i + 6, src.length); j++) {
      const s = /UI_STRING\w*\(\s*"([^"]+)"/.exec(src[j]!);
      if (s) { out.push(item({ key: m[1]!, label: cleanLabel(s[1]!), menu: 'Page context menu', line: i + 1, text: l })); break; }
      if (/^\}/.test(src[j]!)) break;
    }
  });
  return out;
};

// ---------------------------------------------------------------- DocBook handbooks (KDE)

/**
 * `<menuchoice><guimenu>View</guimenu><guisubmenu>…</guisubmenu><guimenuitem>Reload</guimenuitem></menuchoice>`,
 * possibly over several lines; cited at the line where it starts. Only entries naming a menu and an
 * item count (a bare `<guimenu>` is a reference to a whole menu). Entities become words (`&konqueror;`).
 */
const docbookMenus: Extractor = (files, spec) => {
  const out: CensusItem[] = [];
  const src = lines(primary(files, spec));
  const text = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&([a-z]+);/gi, (_, e: string) => (e.toLowerCase() === 'amp' ? '&' : e)).replace(/\s+/g, ' ').trim();
  src.forEach((l, i) => {
    for (const start of l.matchAll(/<menuchoice>/g)) {
      let block = l.slice(start.index);
      for (let j = i + 1; !block.includes('</menuchoice>') && j < Math.min(i + 8, src.length); j++) block += ` ${src[j]}`;
      const body = block.slice(0, block.indexOf('</menuchoice>'));
      const parts = [...body.matchAll(/<(guimenu|guisubmenu|guimenuitem)>([\s\S]*?)<\/\1>/g)].map((m) => ({ kind: m[1]!, label: text(m[2]!) }));
      const items = parts.filter((p) => p.kind === 'guimenuitem');
      if (!parts.some((p) => p.kind === 'guimenu') || items.length === 0) continue;
      const label = cleanLabel(items.at(-1)!.label);
      const where = path(...parts.filter((p) => p !== items.at(-1)).map((p) => p.label));
      out.push(item({ key: `${where} > ${label}`, label, menu: where, line: i + 1, text: l }));
    }
  });
  return out;
};

export const EXTRACTORS: Record<ExtractorId, Extractor> = {
  transcription,
  'rc-menu': rcMenu,
  'webkit-strings': webkitStrings,
  'docbook-menus': docbookMenus,
  'manual-phrases': manualPhrases,
  'mosaic-menu': mosaicMenu,
  'lynx-keymap': lynxKeymap,
  'w3m-func': w3mFunc,
  'elinks-actions': elinksActions,
  'chromium-ids': chromiumIds,
  'brave-ids': chromiumIds,
  'dillo-menu': dilloMenu,
  'xul-menu': xulMenu,
  'firefox-menu': firefoxMenu,
  'falkon-actions': falkonActions,
  'qt-actions': qtActions,
  'otter-enum': otterEnum,
  'vimium-commands': vimiumCommands,
  'qutebrowser-commands': qutebrowserCommands,
  'konqueror-rc': konquerorRc,
  'qt-ui': qtUi,
};

export function extract(spec: SourceSpec, files: Files): CensusItem[] {
  const items = EXTRACTORS[spec.extractor](files, spec);
  // Keys are unique within a source; a repeat means two parser matches for one thing.
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
}
