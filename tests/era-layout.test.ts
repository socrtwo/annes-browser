import { describe, expect, it } from 'vitest';
import { originalLabel, readRc, readTranscription, toMenus } from '../tools/era-layout.ts';
import { buildMenu, layoutCommandIds } from '../app/core/menu/build.ts';
import type { CommandRecord, MenuLayout } from '../app/core/catalog/types.ts';

const rc = [
  'MENU__2 MENU', '{', '    POPUP "&File"', '    {',
  '        MENUITEM "&New Window\\tCtrl+N", 32770', '        MENUITEM "Mail &Document...", 32810', '        MENUITEM SEPARATOR',
  '        MENUITEM SEPARATOR', '        MENUITEM "&Gopher Thing", 999', '        MENUITEM "E&xit", 57665', '    }',
  '    POPUP "&Options"', '    {', '        POPUP "Document &Encoding"', '        {',
  '            MENUITEM "Western", 1', '            MENUITEM "Japanese", 2', '        }', '    }',
  '    POPUP "&Empty"', '    {', '        MENUITEM "Nothing linked", 998', '    }', '}',
  'MENU__3 MENU', '{', '    POPUP "&Help"', '    {', '        MENUITEM "&About", 57664', '    }', '}',
].join('\n');

const links: Record<string, string> = { '32770': 'app.new-window', '32810': 'file.send-link', '57665': 'app.quit', '1': 'view.repair-text-encoding', '2': 'view.repair-text-encoding', '57664': 'help.about' };
const labels: Record<string, string> = { 'app.new-window': 'New Window', 'file.send-link': 'Send Link', 'app.quit': 'Quit', 'view.repair-text-encoding': 'Repair Text Encoding', 'help.about': 'About' };

describe('era layouts generated from real menus', () => {
  it('keeps original wording (minus accelerator markers), order, submenus and separators', () => {
    expect(originalLabel('Save &As...\tCtrl+S')).toBe('Save As...');
    expect(originalLabel('Tom && Jerry')).toBe('Tom & Jerry');
    const menus = toMenus(readRc(rc).get('menu #2')!, (k) => links[k], (id) => labels[id]);
    expect(menus).toEqual([
      { label: 'File', items: ['app.new-window', { command: 'file.send-link', label: 'Mail Document...' }, { separator: true }, { command: 'app.quit', label: 'Exit' }] },
      { label: 'Options', items: [{ command: 'view.repair-text-encoding', label: 'Document Encoding' }] },
    ]);
  });

  it('can join several menu resources, and reads transcriptions', () => {
    const all = readRc(rc);
    expect([...all.keys()]).toEqual(['menu #2', 'menu #3']);
    const t = readTranscription('# h\nFile | New Window | Cmd+N\nWindow > Move | Left\n');
    expect(t.map((e) => [e.path, e.key, e.label])).toEqual([[['File'], 'File/New Window', 'New Window'], [['Window', 'Move'], 'Window > Move/Left', 'Left']]);
  });

  it('labelled items show the historic wording in the built menu', () => {
    const cmd = { id: 'app.quit', label: 'Quit', category: 'app', description: 'x', status: 'implement', phase: 2, platforms: ['desktop'] } as CommandRecord;
    const layout: MenuLayout = { id: 't', label: 'T', menus: [{ label: 'File', items: ['app.quit', { command: 'app.quit', label: 'Exit' }] }] };
    const src = { command: (id: string) => (id === 'app.quit' ? cmd : undefined), isEnabled: () => true, isChecked: () => undefined, keysFor: () => undefined };
    const [file] = buildMenu(layout, src, {} as never);
    expect(file).toMatchObject({ type: 'submenu', items: [{ type: 'command', id: 'app.quit', label: 'Quit' }, { type: 'command', id: 'app.quit', label: 'Exit' }] });
    expect(layoutCommandIds(layout)).toEqual(['app.quit', 'app.quit']);
  });
});
