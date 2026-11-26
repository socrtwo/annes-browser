import { describe, expect, it } from 'vitest';
import { blast } from '../tools/census/blast.ts';
import { extractIs3, listIs3 } from '../tools/census/is3.ts';
import { operaMenusToRc } from '../tools/census/opera.ts';
import { parseAccelerators, parseMenu, parseStringBlock, readResources, toRc } from '../tools/census/pe.ts';
import { EXTRACTORS } from '../tools/census/extractors.ts';
import { readLocal, loadSources } from '../tools/census/run.ts';
import { refUrl } from '../app/core/pages.ts';

const w = (s: string) => Buffer.from(`${s}\0`, 'utf16le');
const u16 = (...n: number[]) => Buffer.concat(n.map((x) => { const b = Buffer.alloc(2); b.writeUInt16LE(x); return b; }));
const u32 = (...n: number[]) => Buffer.concat(n.map((x) => { const b = Buffer.alloc(4); b.writeUInt32LE(x); return b; }));

describe('DCL implode (blast)', () => {
  it('decodes the reference example from zlib', () => {
    expect(blast(Buffer.from([0x00, 0x04, 0x82, 0x24, 0x25, 0x8f, 0x80, 0x7f])).toString()).toBe('AIAIAIAIAIAIA');
  });
  it('refuses a bad header and a truncated stream', () => {
    expect(() => blast(Buffer.from([0x02, 0x04]))).toThrow(/literal flag/);
    expect(() => blast(Buffer.from([0x00, 0x09]))).toThrow(/dictionary/);
    expect(() => blast(Buffer.from([0x00, 0x04, 0x82]))).toThrow(/ends early/);
  });
});

describe('InstallShield 3 archives', () => {
  it('lists directories and files and extracts a member', () => {
    const data = Buffer.from([0x00, 0x04, 0x82, 0x24, 0x25, 0x8f, 0x80, 0x7f]);
    const header = Buffer.alloc(0x33);
    header.writeUInt32LE(0x8c655d13, 0);
    header.writeUInt16LE(1, 0x0c);
    header.writeUInt16LE(1, 0x31);
    const dataAt = header.length;
    const dir = Buffer.concat([u16(1, 6 + 7, 7), Buffer.from('Program')]);
    const name = Buffer.from('a.txt');
    const file = Buffer.alloc(30 + name.length);
    file.writeUInt16LE(0, 1);
    file.writeUInt32LE(13, 3);
    file.writeUInt32LE(data.length, 7);
    file.writeUInt32LE(dataAt, 11);
    file.writeUInt16LE(file.length, 23);
    file.writeUInt8(name.length, 29);
    name.copy(file, 30);
    header.writeUInt32LE(dataAt + data.length, 0x29);
    const arc = Buffer.concat([header, data, dir, file]);
    const [e] = listIs3(arc);
    expect(e).toMatchObject({ path: 'Program/a.txt', size: 13 });
    expect(extractIs3(arc, e!).toString()).toBe('AIAIAIAIAIAIA');
    expect(() => listIs3(Buffer.alloc(64))).toThrow(/not an InstallShield 3/);
  });
});

describe('Windows menu resources', () => {
  it('reads the classic format: popups, items, separators, end flags', () => {
    const menu = Buffer.concat([
      u16(0, 0),
      u16(0x10), w('&File'),
      u16(0, 101), w('&Open...\tCtrl+O'),
      u16(0, 0), w(''),
      u16(0x80, 102), w('E&xit'),
      u16(0x10 | 0x80), w('&Help'),
      u16(0x80, 103), w('&About'),
    ]);
    expect(parseMenu(menu)).toEqual([
      { label: '&File', children: [{ label: '&Open...\tCtrl+O', id: 101 }, { label: '', separator: true }, { label: 'E&xit', id: 102 }] },
      { label: '&Help', children: [{ label: '&About', id: 103 }] },
    ]);
  });

  it('reads MENUEX', () => {
    const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
    const menu = Buffer.concat([
      u16(1, 4), u32(0),
      pad(Buffer.concat([u32(0, 0, 0), u16(0x01 | 0x80), w('&View')])), u32(0),
      pad(Buffer.concat([u32(0, 0, 201), u16(0), w('&Reload')])),
      pad(Buffer.concat([u32(0x800, 0, 0), u16(0x80), w('')])),
    ]);
    expect(parseMenu(menu)).toEqual([{ label: '&View', children: [{ label: '&Reload', id: 201 }, { label: '', separator: true }] }]);
  });

  it('reads accelerators and string tables', () => {
    const acc = Buffer.concat([u16(0x01 | 0x08, 0x4e, 101, 0), u16(0x01, 0x74, 102, 0), u16(0x01 | 0x10 | 0x80, 0x25, 103, 0)]);
    expect(parseAccelerators(acc)).toEqual([{ id: 101, keys: 'Ctrl+N' }, { id: 102, keys: 'F5' }, { id: 103, keys: 'Alt+Left' }]);
    const str = Buffer.concat([u16(0), u16(3), Buffer.from('Hi!', 'utf16le'), ...Array(14).fill(u16(0))]);
    expect([...parseStringBlock(7, str)]).toEqual([[97, 'Hi!']]);
  });

  it('writes rc text the rc-menu extractor reads, with status text and shortcuts', () => {
    const res = {
      menus: new Map([['#2', [{ label: '&File', children: [{ label: 'Open "Here"\tCtrl+O', id: 101 }] }]]]),
      accelerators: [{ id: 101, keys: 'Ctrl+O' }],
      strings: new Map([[101, 'Open a page\nOpen']]),
    };
    const text = toRc(res, ['x'], 'shdocvw');
    expect(text).toContain(`MENUITEM "Open 'Here'\\tCtrl+O", 101    // Open a page | Ctrl+O`);
    expect(toRc(res, ['x'], undefined, false)).toContain('101    // Ctrl+O');
    const items = EXTRACTORS['rc-menu']({ 'm.txt': text }, { files: [{ path: 'm.txt', role: 'primary' }] } as never);
    expect(items.map((i) => [i.key, i.label, i.menu])).toEqual([['101', "Open 'Here'", 'shdocvw menu #2 > File']]);
  });

  it('refuses files that are not 32/64-bit Windows programs', () => {
    expect(() => readResources(Buffer.from('not a program at all, just text....................................'))).toThrow(/MZ/);
    const ne = Buffer.alloc(0x80);
    ne.write('MZ', 0);
    ne.writeUInt32LE(0x40, 0x3c);
    ne.write('NE', 0x40);
    expect(() => readResources(ne)).toThrow(/16-bit/);
  });
});

describe('Opera menu files', () => {
  it('keeps the action and its first argument, and notes platform limits', () => {
    const ini = [
      'Opera Preferences version 2.0', '[Info]', 'Name=x', '[Browser File Menu]',
      'Item, MI_IDM_Exit = Exit', 'Platform Windows-Unix, Item, M_MENU_SHOW_MENU_BAR = Enable menu bar | Disable menu bar',
      'Item, 21525 = Manage, "bookmarks"', 'Item, "Literal" = Zoom to, 50', 'Submenu, X, Y', 'Include, Other Menu',
    ].join('\n');
    const { text, items } = operaMenusToRc(ini, ['h']);
    expect(items).toBe(4);
    const got = EXTRACTORS['rc-menu']({ 'o.txt': text }, { files: [{ path: 'o.txt', role: 'primary' }] } as never);
    expect(got.map((i) => [i.key, i.label, i.menu])).toEqual([
      ['MI_IDM_Exit', 'Exit', 'Browser File Menu'], ['M_MENU_SHOW_MENU_BAR', 'Enable menu bar', 'Browser File Menu'],
      ['21525', 'Manage bookmarks', 'Browser File Menu'], ['LITERAL_8', 'Zoom to 50', 'Browser File Menu'],
    ]);
    expect(text).toContain('[Platform Windows-Unix]');
  });
});

describe('dumped menus as census sources', () => {
  it('each dump records its download and the hash of every program read', () => {
    for (const s of loadSources().filter((x) => x.host === 'dump')) {
      const text = readLocal(s.files[0]!.path);
      expect(text, s.id).toMatch(new RegExp(`^# download: https://archive\\.org/download/${s.repo.replace(/[.]/g, '\\.')}/`, 'm'));
      expect(text, s.id).toMatch(/^# (program|file): .+sha256 [0-9a-f]{64}/m);
    }
  });
  it('link to the Internet Archive item, and nowhere else', () => {
    expect(refUrl('dump/cp32e47/netscape-4.7-win32-menus.txt#L12')).toBe('https://archive.org/details/cp32e47');
    for (const bad of ['dump/../x/a.txt#L1', 'dump/cp32e47/../../a.txt#L1', 'dump/cp32e47/A.TXT#L1', 'dump/cp32e47/a.txt']) expect(refUrl(bad), bad).toBeUndefined();
  });
});

describe('Vivaldi menu files', () => {
  it('labels actions from the command table, in both minified forms', async () => {
    const { vivaldiLabels, vivaldiMenusToRc } = await import('../tools/census/vivaldi.ts');
    const bundle = '{name:"COMMAND_NEW_TAB",action:x,...(0,ab.Z)("command","New Tab")},{name:"COMMAND_X",action:y,...Object(Le.a)("Other")},'
      + 'switch(t.action){case"DOCUMENT_SAVE_LINK":return{...o,...(0,Xi.Z)("Save Link As")};case"DOCUMENT_NONE":return{}};'
      + 'Ce={MENU_FILE:{...(0,N.Z)("win_linux","File")}}';
    const labels = vivaldiLabels(bundle);
    expect([...labels]).toEqual([['COMMAND_NEW_TAB', 'New Tab'], ['COMMAND_X', 'Other'], ['DOCUMENT_SAVE_LINK', 'Save Link As'], ['MENU_FILE', 'File']]);
    const main = [{ type: 'control' }, { action: 'menubar', type: 'menu', children: [{ action: 'MENU_FILE', type: 'folder', children: [
      { action: 'COMMAND_NEW_TAB', type: 'command' }, { action: '', type: 'separator' }, { action: 'COMMAND_UNKNOWN_THING', type: 'command' }] }] }];
    const context = [{ action: 'link', type: 'menu', children: [{ action: 'DOCUMENT_SAVE_LINK', type: 'command' }, { action: 'DOCUMENT_CONTAINER_AV', type: 'container' }] }];
    const { text, items } = vivaldiMenusToRc(main, context, labels, ['h']);
    expect(items).toBe(3);
    const got = EXTRACTORS['rc-menu']({ 'v.txt': text }, { files: [{ path: 'v.txt', role: 'primary' }] } as never);
    expect(got.map((i) => [i.key, i.label, i.menu])).toEqual([
      ['COMMAND_NEW_TAB', 'New Tab', 'File'], ['COMMAND_UNKNOWN_THING', 'Unknown thing', 'File'], ['DOCUMENT_SAVE_LINK', 'Save Link As', 'Context menu: link'],
    ]);
  });
});

describe('transcriptions from scripts', () => {
  it('read an optional shortcut column, and skip lines left for review', () => {
    const t = '# header\nFile | New Window | Cmd+N\nFile | Close\n#? History | Some Page I Visited\n';
    const got = EXTRACTORS['transcription']({ 't.txt': t }, { files: [{ path: 't.txt', role: 'primary' }] } as never);
    expect(got.map((i) => [i.key, i.label, i.menu, i.shortcut])).toEqual([['File/New Window', 'New Window', 'File', 'Cmd+N'], ['File/Close', 'Close', 'File', undefined]]);
  });
});
