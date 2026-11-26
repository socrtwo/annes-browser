/**
 * Read menus, keyboard accelerators and string tables from the resources of a
 * Windows program (PE: Win32 or Win64). No dependencies; nothing is executed.
 *
 * Used to dump the menus of historic closed-source browsers from their own
 * binaries into rc-syntax text (see tools/pe-dump.ts), which the `rc-menu`
 * extractor then reads like any other source.
 */

export interface MenuNode {
  label: string;
  /** Command id; absent for submenus (POPUP). */
  id?: number;
  separator?: boolean;
  children?: MenuNode[];
}

export interface Accelerator { id: number; keys: string }

export interface PeResources {
  /** Menu resources by name (`#128` for numeric ids, or the resource's own name). */
  menus: Map<string, MenuNode[]>;
  accelerators: Accelerator[];
  strings: Map<number, string>;
}

const RT_MENU = 4;
const RT_STRING = 6;
const RT_ACCELERATOR = 9;
/** Preferred language: US English, then whatever comes first. */
const LANG_EN_US = 0x409;

class Reader {
  readonly b: Buffer;
  constructor(b: Buffer) { this.b = b; }
  u16 = (o: number) => this.check(o, 2) && this.b.readUInt16LE(o);
  u32 = (o: number) => this.check(o, 4) && this.b.readUInt32LE(o);
  private check(o: number, n: number): true {
    if (o < 0 || o + n > this.b.length) throw new Error(`PE: read past end at 0x${o.toString(16)}`);
    return true;
  }
  /** NUL-terminated UTF-16LE string at `o`; returns the text and the offset after the NUL. */
  wstr(o: number): [string, number] {
    let e = o;
    while (this.u16(e) !== 0) e += 2;
    return [this.b.toString('utf16le', o, e), e + 2];
  }
}

/** File offset of a relative virtual address, from the section table. */
function rvaToOffset(r: Reader, sections: { va: number; vsize: number; raw: number; rawSize: number }[], rva: number): number {
  for (const s of sections) {
    if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.raw;
  }
  throw new Error(`PE: address 0x${rva.toString(16)} is in no section`);
}

/** Raw data of every resource: type → name → language → bytes. */
export function resourceData(buf: Buffer): Map<number | string, Map<number | string, Map<number, Buffer>>> {
  const r = new Reader(buf);
  if (r.u16(0) !== 0x5a4d) throw new Error('not a Windows program (no MZ header)');
  const pe = r.u32(0x3c);
  if (r.u32(pe) !== 0x00004550) throw new Error('not a PE program (16-bit NE or DOS programs are not supported)');
  const nSections = r.u16(pe + 6);
  const optSize = r.u16(pe + 20);
  const opt = pe + 24;
  const magic = r.u16(opt);
  const dirs = opt + (magic === 0x20b ? 112 : 96);
  const resRva = r.u32(dirs + 2 * 8);
  const sections = Array.from({ length: nSections }, (_, i) => {
    const s = opt + optSize + i * 40;
    return { vsize: r.u32(s + 8), va: r.u32(s + 12), rawSize: r.u32(s + 16), raw: r.u32(s + 20) };
  });
  const out = new Map<number | string, Map<number | string, Map<number, Buffer>>>();
  if (!resRva) return out;
  const base = rvaToOffset(r, sections, resRva);

  const entries = (dir: number) => {
    const n = r.u16(dir + 12) + r.u16(dir + 14);
    return Array.from({ length: n }, (_, i) => {
      const e = dir + 16 + i * 8;
      const name = r.u32(e);
      const off = r.u32(e + 4);
      const key: number | string = name & 0x80000000
        ? buf.toString('utf16le', base + (name & 0x7fffffff) + 2, base + (name & 0x7fffffff) + 2 + 2 * r.u16(base + (name & 0x7fffffff)))
        : name;
      return { key, sub: (off & 0x80000000) !== 0, at: base + (off & 0x7fffffff) };
    });
  };

  for (const t of entries(base)) {
    if (!t.sub) continue;
    const byName = new Map<number | string, Map<number, Buffer>>();
    for (const n of entries(t.at)) {
      if (!n.sub) continue;
      const byLang = new Map<number, Buffer>();
      for (const l of entries(n.at)) {
        if (l.sub) continue;
        const off = rvaToOffset(r, sections, r.u32(l.at));
        const size = r.u32(l.at + 4);
        if (off + size > buf.length) throw new Error('PE: resource runs past end of file');
        byLang.set(typeof l.key === 'number' ? l.key : 0, buf.subarray(off, off + size));
      }
      byName.set(n.key, byLang);
    }
    out.set(t.key, byName);
  }
  return out;
}

const pickLang = (m: Map<number, Buffer>): Buffer => m.get(LANG_EN_US) ?? m.values().next().value!;

/** RT_MENU: the classic format (version 0) and MENUEX (version 1). */
export function parseMenu(b: Buffer): MenuNode[] {
  const r = new Reader(b);
  const version = r.u16(0);
  if (version === 0) {
    let o = 4;
    const level = (): MenuNode[] => {
      const items: MenuNode[] = [];
      for (;;) {
        const flags = r.u16(o); o += 2;
        const popup = (flags & 0x10) !== 0;
        let id: number | undefined;
        if (!popup) { id = r.u16(o); o += 2; }
        const [label, next] = r.wstr(o); o = next;
        const node: MenuNode = popup ? { label, children: [] } : flags === 0 && id === 0 && label === '' ? { label: '', separator: true } : { label, id: id! };
        if (popup) node.children = level();
        items.push(node);
        if (flags & 0x80) return items;
      }
    };
    return level();
  }
  if (version === 1) {
    let o = 4 + r.u16(2);
    const level = (): MenuNode[] => {
      const items: MenuNode[] = [];
      for (;;) {
        const type = r.u32(o);
        const id = r.u32(o + 8);
        const flags = r.u16(o + 12);
        const [label, next] = r.wstr(o + 14);
        o = (next + 3) & ~3;
        const popup = (flags & 0x01) !== 0;
        let node: MenuNode;
        if (popup) { o += 4; node = { label, children: level() }; }
        else node = type & 0x800 ? { label: '', separator: true } : { label, id };
        items.push(node);
        if (flags & 0x80) return items;
      }
    };
    return level();
  }
  throw new Error(`unknown menu resource version ${version}`);
}

const VK: Record<number, string> = {
  0x08: 'Backspace', 0x09: 'Tab', 0x0d: 'Enter', 0x1b: 'Esc', 0x20: 'Space', 0x21: 'PageUp', 0x22: 'PageDown',
  0x23: 'End', 0x24: 'Home', 0x25: 'Left', 0x26: 'Up', 0x27: 'Right', 0x28: 'Down', 0x2d: 'Insert', 0x2e: 'Delete',
  0x6b: 'Num+', 0x6d: 'Num-', 0xbb: '=', 0xbd: '-', 0xbf: '/', 0xdb: '[', 0xdd: ']',
};

/** RT_ACCELERATOR: 8-byte entries, last one flagged 0x80. */
export function parseAccelerators(b: Buffer): Accelerator[] {
  const r = new Reader(b);
  const out: Accelerator[] = [];
  for (let o = 0; o + 8 <= b.length; o += 8) {
    const flags = r.u16(o);
    const key = r.u16(o + 2);
    const id = r.u16(o + 4);
    const virt = (flags & 0x01) !== 0;
    const name = virt
      ? (VK[key] ?? (key >= 0x70 && key <= 0x87 ? `F${key - 0x6f}` : (key >= 0x30 && key <= 0x5a ? String.fromCharCode(key) : `VK${key.toString(16)}`)))
      : (key < 0x20 ? String.fromCharCode(key + 0x40) : String.fromCharCode(key).toUpperCase());
    const mods = [flags & 0x08 || (!virt && key < 0x20) ? 'Ctrl' : '', flags & 0x10 ? 'Alt' : '', flags & 0x04 ? 'Shift' : ''].filter(Boolean);
    out.push({ id, keys: [...mods, name].join('+') });
    if (flags & 0x80) break;
  }
  return out;
}

/** RT_STRING block `block`: strings (block-1)*16 .. +15, each length-prefixed UTF-16. */
export function parseStringBlock(block: number, b: Buffer): Map<number, string> {
  const r = new Reader(b);
  const out = new Map<number, string>();
  let o = 0;
  for (let i = 0; i < 16 && o + 2 <= b.length; i++) {
    const n = r.u16(o); o += 2;
    if (n) out.set((block - 1) * 16 + i, b.toString('utf16le', o, o + 2 * n));
    o += 2 * n;
  }
  return out;
}

export function readResources(buf: Buffer): PeResources {
  const data = resourceData(buf);
  const menus = new Map<string, MenuNode[]>();
  for (const [name, langs] of data.get(RT_MENU) ?? []) menus.set(typeof name === 'number' ? `#${name}` : name, parseMenu(pickLang(langs)));
  const accelerators: Accelerator[] = [];
  for (const langs of (data.get(RT_ACCELERATOR) ?? new Map()).values()) accelerators.push(...parseAccelerators(pickLang(langs)));
  const strings = new Map<number, string>();
  for (const [block, langs] of data.get(RT_STRING) ?? []) {
    if (typeof block === 'number') for (const [k, v] of parseStringBlock(block, pickLang(langs))) strings.set(k, v);
  }
  return { menus, accelerators, strings };
}

/** One-line, rc-safe text: no quotes, no control characters; a tab becomes `\t`. */
const rcText = (s: string) => s.replace(/\t/g, '\\t').replace(/"/g, "'").replace(/[\u0000-\u001f]/g, ' ');

/**
 * rc-syntax dump. Each MENUITEM is followed by a comment with the program's own
 * status-bar text for that command id (MFC convention: the string with the
 * same id, up to the first newline) and its keyboard shortcut. Programs that do
 * not follow that convention (Internet Explorer) are dumped with statusText false.
 */
export function toRc(res: PeResources, header: string[], tag?: string, statusText = true): string {
  const keysFor = new Map<number, string[]>();
  for (const a of res.accelerators) keysFor.set(a.id, [...(keysFor.get(a.id) ?? []), a.keys]);
  const out = header.map((h) => `# ${h}`);
  const emit = (nodes: MenuNode[], depth: number) => {
    const pad = '    '.repeat(depth);
    for (const n of nodes) {
      if (n.separator) { out.push(`${pad}MENUITEM SEPARATOR`); continue; }
      if (n.children) {
        out.push(`${pad}POPUP "${rcText(n.label) || '(untitled)'}"`, `${pad}{`);
        emit(n.children, depth + 1);
        out.push(`${pad}}`);
        continue;
      }
      if (!n.label) continue;
      const help = statusText ? res.strings.get(n.id!)?.split('\n')[0]?.trim() : undefined;
      const keys = keysFor.get(n.id!);
      const note = [help, keys?.join(', ')].filter(Boolean).join(' | ');
      out.push(`${pad}MENUITEM "${rcText(n.label)}", ${n.id}${note ? `    // ${rcText(note)}` : ''}`);
    }
  };
  for (const [name, nodes] of res.menus) {
    out.push('', `MENU_${tag ? `_${tag.replace(/\W/g, '')}_` : ''}${name.replace(/\W/g, '_')} MENU`, '{');
    emit(nodes, 1);
    out.push('}');
  }
  return `${out.join('\n')}\n`;
}
