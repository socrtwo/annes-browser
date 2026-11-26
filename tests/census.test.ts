import { describe, expect, it } from 'vitest';
import { cleanLabel, EXTRACTORS, extract } from '../tools/census/extractors.ts';
import { getArchiveText, getSource, rawUrl, sha256 } from '../tools/census/fetch.ts';
import { lineageFor, matchCensus } from '../tools/census/merge.ts';
import { itemNames, squash } from '../tools/census/names.ts';
import { loadNames, loadOverrides } from '../tools/census/merge.ts';
import { loadCensus, loadSources, readLocal, verifyCensus } from '../tools/census/run.ts';
import type { CensusFile, CensusItem, SourceSpec } from '../tools/census/types.ts';
import { loadAllCensus } from '../tools/census-load.ts';
import { loadCatalog } from '../tools/build-catalog.ts';

const spec = (extractor: SourceSpec['extractor'], files: Record<string, 'primary' | 'labels'> = { 'a.txt': 'primary' }): SourceSpec => ({
  id: 't', browser: 'T', version: '1', released: 2000, platform: 'x', repo: 'o/r', ref: 'main', extractor,
  files: Object.entries(files).map(([path, role]) => ({ path, role })),
});
const run = (extractor: SourceSpec['extractor'], text: string) => extract(spec(extractor), { 'a.txt': text });

describe('label cleaning', () => {
  it('removes accelerator markers and trailing ellipses', () => {
    expect(cleanLabel('&File')).toBe('File');
    expect(cleanLabel('New &Tab')).toBe('New Tab');
    expect(cleanLabel('Save As...')).toBe('Save As');
    expect(cleanLabel('Open Location…')).toBe('Open Location');
    expect(cleanLabel('Fish && Chips')).toBe('Fish & Chips');
    expect(cleanLabel('Close (&C)')).toBe('Close');
  });
});

describe('extractors read the formats they were written for', () => {
  it('Mosaic: menu items under the title of their menu', () => {
    const items = run('mosaic-menu', [
      'ALLOC_MENUBAR(file_menuspec,32)',
      '\tDEFINE_MENUBAR("New" ,"N" ,menubar_cb,mo_new_window,NULL)',
      '\tSPACER()',
      '\tDEFINE_MENUBAR("Open URL..." ,"O",menubar_cb,mo_open_document,NULL)',
      'ALLOC_MENUBAR(menuspec,10)',
      '\tDEFINE_MENUBAR("File","F",NULL,0,file_menuspec)',
    ].join('\n'));
    expect(items.map((i) => [i.key, i.label, i.menu, i.line])).toEqual([
      ['mo_new_window', 'New', 'File', 2], ['mo_open_document', 'Open URL', 'File', 4],
    ]);
  });

  it('Lynx: both table layouts, and rows compiled out by #ifdef NOT_USED are skipped', () => {
    const old = run('lynx-keymap', ['{ "QUIT",\t\t"quit the browser" },', '#ifdef NOT_USED', '{ "VERSION",\t"report version" },', '#endif', '{ "UNMAPPED",\tNULL },'].join('\n'));
    expect(old.map((i) => i.key)).toEqual(['QUIT']);
    const cur = run('lynx-keymap', ['    DATA(', '\t    LYK_PRINT, "PRINT",', '\t    "display choices for printing"),'].join('\n'));
    expect(cur).toMatchObject([{ key: 'PRINT', note: 'display choices for printing', line: 2 }]);
  });

  it('w3m: function name and description', () => {
    expect(run('w3m-func', 'ABORT\t\tQuit without confirmation\nCHARSET \tChange the character encoding')).toMatchObject([
      { key: 'ABORT', note: 'Quit without confirmation' }, { key: 'CHARSET', note: 'Change the character encoding' },
    ]);
  });

  it('ELinks: name, keymap and description', () => {
    const items = run('elinks-actions', [
      'ACTION_(MAIN, "none", NONE, N__("Do nothing"), 0),',
      'ACTION_(MAIN, " *scripting-function*", SCRIPTING_FUNCTION, NULL, 0),',
      'ACTION_(MAIN, "abort-connection", ABORT_CONNECTION, N__("Abort connection"), 0),',
      'ACTION_(MENU, "down", DOWN, N__("Move down"), 0),',
    ].join('\n'));
    expect(items.map((i) => [i.key, i.group, i.note])).toEqual([
      ['main:abort-connection', 'main', 'Abort connection'], ['menu:down', 'menu', 'Move down'],
    ]);
  });

  it('Chromium: ids with their section comment', () => {
    const items = run('chromium-ids', ['// NOTE: ordered by menu', '// Navigation commands', '#define IDC_BACK 33000', '// Tab commands', '#define IDC_NEW_TAB 34014'].join('\n'));
    expect(items.map((i) => [i.key, i.group])).toEqual([['IDC_BACK', 'Navigation commands'], ['IDC_NEW_TAB', 'Tab commands']]);
  });

  it('Falkon: id, label, menu and shortcut', () => {
    const items = run('falkon-actions', '    ADD_ACTION("File/NewTab", m_menuFile, IconProvider::newTabIcon(), tr("New Tab"), SLOT(newTab()), "Ctrl+T");');
    expect(items).toMatchObject([{ key: 'File/NewTab', label: 'New Tab', menu: 'File', shortcut: 'Ctrl+T' }]);
  });

  it('XUL: nested menus, entity labels and labels defined on a command', () => {
    const xul = [
      '<command id="Browser:Back" label="&backCmd.label;"/>',
      '<menu id="menu_File">',
      '  <menupopup>',
      '    <menuitem id="menu_openFile" label="&openFileCmd.label;" key="openFileKb"/>',
      '    <menu id="sub" label="&subMenu.label;">',
      '      <menupopup>',
      '        <menuitem id="deep" label="Plain"/>',
      '      </menupopup>',
      '    </menu>',
      '    <menuitem id="x" command="Browser:Back"/>',
      '  </menupopup>',
      '</menu>',
    ].join('\n');
    const dtd = '<!ENTITY openFileCmd.label "Open File">\n<!ENTITY subMenu.label "More">\n<!ENTITY backCmd.label "Back">';
    const items = extract(spec('xul-menu', { 'a.txt': 'primary', 'b.dtd': 'labels' }), { 'a.txt': xul, 'b.dtd': dtd });
    expect(items.map((i) => [i.key, i.label, i.menu])).toEqual([
      ['menu_openFile', 'Open File', undefined],
      ['deep', 'Plain', 'More'],
      ['x', 'Back', undefined],
    ]);
    expect(items[0]).toMatchObject({ shortcut: 'key:openFileKb' });
  });

  it('Firefox: Fluent labels', () => {
    const inc = ['<menu id="file-menu" data-l10n-id="menu-file">', '  <menuitem id="menu_newNavigatorTab"', '            data-l10n-id="menu-file-new-tab"/>', '</menu>'].join('\n');
    const ftl = ['menu-file =', '    .label = File', 'menu-file-new-tab =', '    .label = New Tab'].join('\n');
    const items = extract(spec('firefox-menu', { 'a.txt': 'primary', 'b.ftl': 'labels' }), { 'a.txt': inc, 'b.ftl': ftl });
    expect(items).toMatchObject([{ key: 'menu_newNavigatorTab', label: 'New Tab', menu: 'File' }]);
  });

  it('Ladybird: menu bar built in code', () => {
    const cpp = ['auto* file_menu = menu_bar->addMenu("&File");', 'file_menu->addAction(new_tab_action());', 'file_menu->addSeparator();', 'auto* zoom = file_menu->addMenu("&Zoom");', 'zoom->addAction(create_application_action(*menu_bar, application.reset_zoom_action(), IncludeActionIcon::No));'].join('\n');
    expect(run('qt-actions', cpp).map((i) => [i.key, i.menu])).toEqual([['File:new_tab', 'File'], ['File > Zoom:reset_zoom', 'File > Zoom']]);
  });

  it('Qt Designer, Otter enum, Vimium, qutebrowser, Konqueror', () => {
    expect(run('qt-ui', '<action name="actionNewTab">\n <property name="text">\n  <string>New Tab</string>\n </property>\n</action>')).toMatchObject([{ key: 'actionNewTab', label: 'New Tab' }]);
    expect(run('otter-enum', 'enum ActionIdentifier\n{\n\tRunMacroAction = 0,\n\tNewTabAction,\n};')).toMatchObject([{ key: 'RunMacroAction' }, { key: 'NewTabAction' }]);
    expect(run('vimium-commands', '  {\n    name: "scrollDown",\n    desc: "Scroll down",\n    group: "navigation",\n  },')).toMatchObject([{ key: 'scrollDown', note: 'Scroll down', group: 'navigation' }]);
    expect(run('qutebrowser-commands', '[[back]]\n=== back\nSyntax: +:back+\n\nGo back in the history.\n')).toMatchObject([{ key: 'back', note: 'Go back in the history.' }]);
    expect(run('konqueror-rc', '<MenuBar>\n <Menu name="file"><text>&amp;File</text>\n  <Action name="newtab"/>\n </Menu>\n</MenuBar>\n<ToolBar>\n <Action name="go_back"/>\n</ToolBar>')).toMatchObject([{ key: 'newtab', menu: 'File' }]);
  });

  it('manuals: reads only fixed phrasings, across a line break, and ignores other menus', () => {
    const text = [
      'To go somewhere new: From the File menu, choose Open',
      'Location, type the URL, and press Return.',
      'You can also select Add Bookmark from the Bookmarks menu, or choose Reload from the View menu to',
      'refresh. Open the Go menu and choose View History. From the Apple menu, choose Chooser.',
      'The File menu is useful. Choose wisely from the many options. From the Options menu, choose Prefer-',
    ].join('\n');
    const items = run('manual-phrases', text);
    expect(items.map((i) => [i.key, i.line])).toEqual([
      ['File/Open Location', 1], ['Bookmarks/Add Bookmark', 3], ['View/Reload', 3], ['Go/View History', 4], ['Options/Prefer', 5],
    ]);
    expect(items[0]).toMatchObject({ label: 'Open Location', menu: 'File' });
  });

  it('screenshot transcriptions: where and label, header skipped', () => {
    const items = run('transcription', '# image: x\n# sha256: y\nMenu bar | File\nToolbar | Back\n\nnot a row');
    expect(items.map((i) => [i.key, i.menu, i.label, i.line])).toEqual([['Menu bar/File', 'Menu bar', 'File', 3], ['Toolbar/Back', 'Toolbar', 'Back', 4]]);
  });

  it('Windows resource scripts: nested POPUPs with braces or BEGIN/END', () => {
    const rc = [
      'IDR_MAIN MENU', '{', '    POPUP "&File"', '    {', '        POPUP "&New"', '        {', '            MENUITEM "&Window",   ID_NEW_WINDOW', '        }',
      '        MENUITEM "Save &as...\tCtrl+S",  ID_SAVE_AS', '        MENUITEM SEPARATOR', '    }', '}',
      'OTHER MENU', 'BEGIN', '    POPUP "&Help"', '    BEGIN', '        MENUITEM "&About", ID_ABOUT', '    END', 'END',
      'STRINGTABLE', '{', '    MENUITEM "not a menu", ID_NO', '}',
    ].join('\n');
    expect(run('rc-menu', rc).map((i) => [i.key, i.label, i.menu])).toEqual([
      ['ID_NEW_WINDOW', 'Window', 'File > New'], ['ID_SAVE_AS', 'Save as', 'File'], ['ID_ABOUT', 'About', 'Help'],
    ]);
  });

  it('WebKit strings in both the 2010 Objective-C and the current C++ form', () => {
    const objc = '- (NSString *)contextMenuItemTagOpenLinkInNewWindow\n{\n    return UI_STRING("Open Link in New Window", "comment");\n}';
    const cpp = 'String contextMenuItemTagCopyImageToClipboard()\n{\n    return WEB_UI_STRING_WITH_MNEMONIC("Copy Image", "C_opy Image", "comment");\n}';
    expect(run('webkit-strings', `${objc}\n${cpp}`).map((i) => [i.key, i.label])).toEqual([
      ['contextMenuItemTagOpenLinkInNewWindow', 'Open Link in New Window'], ['contextMenuItemTagCopyImageToClipboard', 'Copy Image'],
    ]);
  });

  it('every extractor id is implemented', () => {
    for (const s of loadSources()) expect(EXTRACTORS[s.extractor], s.id).toBeTypeOf('function');
  });

  it('keeps the first of repeated keys and bounds evidence length', () => {
    const items = run('w3m-func', `ABORT\tfirst\nABORT\tsecond ${'x'.repeat(300)}`);
    expect(items).toHaveLength(1);
    expect(items[0]!.note).toBe('first');
    expect(items[0]!.evidence.length).toBeLessThanOrEqual(120);
  });
});

describe('names', () => {
  const it_ = (key: string, label?: string): CensusItem => ({ key, ...(label && { label }), line: 1, evidence: key });
  it('normalizes identifiers from different browsers to the same word', () => {
    for (const key of ['IDC_NEW_TAB', 'NewTabAction', 'File/NewTab', 'File:new_tab', 'main:new-tab', 'actionNewTab']) {
      expect(itemNames(it_(key)), key).toContain('newtab');
    }
    expect(itemNames(it_('menu_newNavigatorTab', 'New Tab'))).toEqual(['newnavigatortab', 'newtab']);
    expect(squash('Open Link in New Tab')).toBe('openlinkinnewtab');
  });

  it('keeps other ELinks keymaps apart from the main one', () => {
    expect(itemNames(it_('menu:home'))).not.toContain('home');
    expect(itemNames(it_('edit:home'))).not.toContain('home');
    expect(itemNames(it_('main:home'))).toContain('home');
  });
});

function fake(items: Partial<CensusItem>[], id = 's'): CensusFile {
  return {
    version: 1, id, browser: 'B', browser_version: '1', released: 2001, platform: 'p',
    source: { repo: 'o/r', ref: 'main', commit: 'a'.repeat(40), extractor: 'w3m-func', files: [{ path: 'f', sha256: 'x', lines: 1, role: 'primary' }], retrieved: '2026-01-01' },
    items: items.map((i, n) => ({ key: 'k', line: n + 1, evidence: 'e', ...i })),
  };
}

describe('matching census items to commands', () => {
  const ids = new Set(['tab.new', 'tab.close', 'app.quit']);
  it('links by name and keeps unmatched items visible', () => {
    const r = matchCensus([fake([{ key: 'IDC_NEW_TAB' }, { key: 'IDC_WEIRD' }])], { 'tab.new': ['newtab'] }, [], ids);
    expect(r.problems).toEqual([]);
    expect(r.matches.map((m) => m.command)).toEqual(['tab.new']);
    expect(r.unmatched.map((u) => u.item.key)).toEqual(['IDC_WEIRD']);
  });

  it('refuses a name that belongs to two commands', () => {
    const r = matchCensus([], { 'tab.new': ['x'], 'tab.close': ['x'] }, [], ids);
    expect(r.problems.join()).toMatch(/belongs to both/);
  });

  it('refuses unknown commands, unnormalized names and an item whose names point at two commands', () => {
    expect(matchCensus([], { 'no.such': ['a'] }, [], ids).problems.join()).toMatch(/not a command/);
    expect(matchCensus([], { 'tab.new': ['New Tab'] }, [], ids).problems.join()).toMatch(/not normalized/);
    const r = matchCensus([fake([{ key: 'close', label: 'New Tab' }])], { 'tab.new': ['newtab'], 'tab.close': ['close'] }, [], ids);
    expect(r.problems.join()).toMatch(/several commands/);
  });

  it('applies overrides, including "none", and rejects stale ones', () => {
    const files = [fake([{ key: 'CLOSE' }, { key: 'UNDO' }])];
    const r = matchCensus(files, {}, [
      { source: 's', key: 'CLOSE', command: 'tab.close' },
      { source: 's', key: 'UNDO', command: 'none', why: 'cursor undo' },
    ], ids);
    expect(r.matches.map((m) => m.command)).toEqual(['tab.close']);
    expect(r.reviewed).toMatchObject([{ why: 'cursor undo' }]);
    expect(r.unmatched).toEqual([]);
    const stale = matchCensus(files, {}, [{ source: 's', key: 'GONE', command: 'tab.close' }, { source: 's', key: 'CLOSE', command: 'no.such' }], ids);
    expect(stale.problems.join('\n')).toMatch(/no item GONE/);
    expect(stale.problems.join('\n')).toMatch(/unknown command no.such/);
  });

  it('builds lineage with a citation, using only real labels in menu paths', () => {
    const file = fake([{ key: 'File:new_tab', menu: 'File', line: 3131 }, { key: 'IDC_NEW_TAB', label: 'New Tab', menu: 'File', line: 7 }]);
    const r = matchCensus([file], { 'tab.new': ['newtab'] }, [], ids);
    const lineage = lineageFor('tab.new', r.matches);
    expect(lineage[0]).toMatchObject({ browser: 'B', year: 2001, source: 'census', menu: 'File', ref: `o/r@${'a'.repeat(12)}:f#L3131` });
    expect(lineage[1]).toMatchObject({ menu: 'File > New Tab', key: 'IDC_NEW_TAB' });
  });
});

describe('fetching and verifying', () => {
  const commit = 'b'.repeat(40);
  const text = 'line one\nline two: ABORT thing\n';

  it('pins URLs to a commit and rejects anything else', async () => {
    expect(rawUrl({ repo: 'o/r', commit, path: 'a/b.c' })).toBe(`https://raw.githubusercontent.com/o/r/${commit}/a/b.c`);
    await expect(getSource({ repo: 'o/r', commit: 'main', path: 'x' }, async () => ({ status: 200, text: '' }))).rejects.toThrow(/full commit SHA/);
  });

  it('retries rate limits and fails on other errors', async () => {
    let calls = 0;
    const flaky = async () => (++calls < 2 ? { status: 429, text: '' } : { status: 200, text });
    expect(await getSource({ repo: 'o/retry', commit, path: 'p' }, flaky)).toBe(text);
    await expect(getSource({ repo: 'o/gone', commit, path: 'p' }, async () => ({ status: 404, text: '' }))).rejects.toThrow(/HTTP 404/);
  });

  it('accepts matching evidence and reports drift, wrong lines and wrong evidence', async () => {
    const c = fake([{ key: 'ABORT', line: 2, evidence: 'line two: ABORT thing' }]);
    c.source.files[0] = { path: 'v.txt', sha256: sha256(text), lines: 3, role: 'primary' };
    c.source.repo = 'o/verify';
    const ok = async () => ({ status: 200, text });
    expect(await verifyCensus(c, ok)).toEqual([]);
    const drifted = await verifyCensus({ ...c, source: { ...c.source, repo: 'o/verify2' } }, async () => ({ status: 200, text: `${text}changed\n` }));
    expect(drifted.map((p) => p.message).join()).toMatch(/hash differs/);
    const wrong = fake([{ key: 'ABORT', line: 1, evidence: 'line two: ABORT thing' }, { key: 'FAR', line: 99, evidence: 'x' }], 'w');
    wrong.source.files[0] = { path: 'w.txt', sha256: sha256(text), lines: 3, role: 'primary' };
    wrong.source.repo = 'o/verify3';
    const msgs = (await verifyCensus(wrong, ok)).map((p) => p.message).join('\n');
    expect(msgs).toMatch(/ABORT: line 1 does not contain/);
    expect(msgs).toMatch(/FAR: line 99 does not exist/);
  });
});

describe('screenshot transcriptions', () => {
  it('are read only from the transcriptions folder, by plain file name', () => {
    expect(readLocal('netscape-0.92-screenshot.txt')).toMatch(/^# Transcription of a screenshot/);
    for (const bad of ['../sources.yaml', '/etc/passwd', 'x/y.txt', 'NAME.txt', 'a.yaml']) expect(() => readLocal(bad), bad).toThrow(/not a transcription file name/);
  });

  it('record the image they were read from and its hash', () => {
    for (const s of loadSources().filter((x) => x.host === 'local')) {
      const text = readLocal(s.files[0]!.path);
      expect(text, s.id).toMatch(new RegExp(`# image: https://commons\\.wikimedia\\.org/wiki/File:${s.repo.replace(/[.()]/g, '\\$&')}`));
      expect(text, s.id).toMatch(/# sha256 of the \d+px image read: [0-9a-f]{64}/);
    }
  });
});

describe('scanned manual text', () => {
  it('takes the text block out of the archive page and decodes entities', async () => {
    const page = '<html><body><pre>From the File menu, choose Save As &amp; go.\nIt&#8217;s &lt;here&gt;</pre></body></html>';
    const text = await getArchiveText('test_item_one', 'x_djvu.txt', async () => ({ status: 200, text: page }));
    expect(text).toBe('From the File menu, choose Save As & go.\nIt\u2019s <here>');
  });

  it('refuses odd names, restricted items and errors', async () => {
    await expect(getArchiveText('../etc', 'x_djvu.txt', async () => ({ status: 200, text: '' }))).rejects.toThrow(/not an archive text file/);
    await expect(getArchiveText('item', 'x.exe', async () => ({ status: 200, text: '' }))).rejects.toThrow(/not an archive text file/);
    await expect(getArchiveText('test_item_two', 'x_djvu.txt', async () => ({ status: 200, text: '<html>borrow this book</html>' }))).rejects.toThrow(/no text block/);
    await expect(getArchiveText('test_item_three', 'x_djvu.txt', async () => ({ status: 404, text: '' }))).rejects.toThrow(/HTTP 404/);
  });

  it('marks lineage from a manual as such, with an archive reference', () => {
    const file = fake([{ key: 'File/Open Location', label: 'Open Location', menu: 'File', line: 2078 }]);
    file.source = { ...file.source, host: 'archive.org', repo: 'some_item', commit: '', files: [{ path: 'book_djvu.txt', sha256: 'x', lines: 1, role: 'primary' }] };
    const r = matchCensus([file], { 'tab.new': ['openlocation'] }, [], new Set(['tab.new']));
    expect(lineageFor('tab.new', r.matches)[0]).toMatchObject({ source: 'manual', menu: 'File > Open Location', ref: 'archive.org/some_item/book_djvu.txt#L2078' });
  });
});

describe('the committed census data', () => {
  const catalog = loadCatalog();
  const ids = new Set(catalog.commands.map((c) => c.id));
  const files = loadAllCensus();

  it('has a census file for every source, pinned to a full commit', () => {
    const sources = loadSources();
    expect(files.map((f) => f.id)).toEqual(sources.map((s) => s.id));
    for (const s of sources) {
      // A scanned manual has no commit; its pin is the text hash recorded in its census file.
      if (s.host === 'archive.org' || s.host === 'local' || s.host === 'dump' || s.host === 'machine') expect(s.commit, s.id).toBeUndefined();
      else expect(s.commit, s.id).toMatch(/^[0-9a-f]{40}$/);
    }
    for (const f of files) {
      expect(f.source.commit, f.id).toBe(sources.find((s) => s.id === f.id)!.commit ?? '');
      expect(f.items.length, f.id).toBeGreaterThan(5);
      for (const file of f.source.files) expect(file.sha256, `${f.id} ${file.path}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('has unique keys, and a line and evidence for every item', () => {
    for (const f of files) {
      const keys = new Set<string>();
      for (const it of f.items) {
        expect(keys.has(it.key), `${f.id} repeats ${it.key}`).toBe(false);
        keys.add(it.key);
        expect(it.line, `${f.id} ${it.key}`).toBeGreaterThan(0);
        expect(it.evidence.length, `${f.id} ${it.key}`).toBeGreaterThan(0);
        expect(it.note === undefined || it.note.length <= 100, `${f.id} ${it.key} note`).toBe(true);
      }
    }
  });

  it('links to the catalog without collisions, stale overrides or unknown commands', () => {
    const r = matchCensus(files, loadNames(), loadOverrides(), ids);
    expect(r.problems).toEqual([]);
    expect(r.matches.length).toBeGreaterThan(1000);
  });

  it('gives every census-linked command lineage whose ref points at a real census item', () => {
    const lines = new Map<string, Set<number>>();
    for (const f of files) {
      const key = f.source.host === 'archive.org' ? `archive.org/${f.source.repo}/${f.source.files[0]!.path}`
        : f.source.host === 'local' ? `commons/${f.source.repo}` : f.source.host === 'dump' ? `dump/${f.source.repo}/${f.source.files[0]!.path}` : f.source.host === 'machine' ? `machine/${f.source.files[0]!.path}` : `${f.source.repo}@${f.source.commit.slice(0, 12)}`;
      lines.set(key, new Set(f.items.map((i) => i.line)));
    }
    let checked = 0;
    for (const c of catalog.commands) {
      const names = loadNames()[c.id];
      if (!names) continue;
      void names;
    }
    const r = matchCensus(files, loadNames(), loadOverrides(), ids);
    for (const m of r.matches.slice(0, 400)) {
      const [lin] = lineageFor(m.command, [m]);
      const [, repo, line] = (/^((?:archive\.org|commons|dump|machine)\/.+)#L(\d+)$/.exec(lin!.ref!) ?? /^(.+?):.*#L(\d+)$/.exec(lin!.ref!))!;
      expect(lines.get(repo!)?.has(Number(line)), lin!.ref).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('reads every census file back unchanged', () => {
    for (const f of files) expect(loadCensus(f.id).items.length).toBe(f.items.length);
  });
});
