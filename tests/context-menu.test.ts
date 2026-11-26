import { describe, expect, it } from 'vitest';
import { type ContextTarget, contextMenuItems } from '../app/core/menu/context.ts';
import { checkCatalog, loadCatalog } from '../tools/build-catalog.ts';

const base: ContextTarget = {
  x: 10.4, y: 20.6, linkURL: '', srcURL: '', mediaType: 'none', hasImageContents: false, selectionText: '',
  isEditable: false, misspelledWord: '', dictionarySuggestions: [], inBrowserUi: false,
  editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
};
const ids = (t: Partial<ContextTarget>) => contextMenuItems({ ...base, ...t }).map((i) => ('separator' in i ? '-' : i.id));

describe('context menu', () => {
  it('offers page commands on an empty area', () => {
    expect(ids({})).toEqual([
      'nav.back', 'nav.forward', 'nav.reload', '-', 'bookmark.toggle', 'file.save-page-as', 'file.print', '-',
      'view.page-source', 'page.info', '-', 'tools.inspect-element',
    ]);
    const inspect = contextMenuItems(base).at(-1);
    expect(inspect).toEqual({ id: 'tools.inspect-element', args: { x: 10, y: 21 } });
  });

  it('offers link commands, passing the link only as an argument', () => {
    const items = contextMenuItems({ ...base, linkURL: 'https://example.com/a' });
    expect(items.slice(0, 3)).toEqual([
      { id: 'tab.open-link', args: { url: 'https://example.com/a' } },
      { id: 'file.save-link', args: { url: 'https://example.com/a' }, enabled: true },
      { id: 'edit.copy-link', args: { url: 'https://example.com/a' } },
    ]);
    expect(ids({ linkURL: 'gopher://g.example/1/' })).toContain('tab.open-link');
  });

  it('ignores links and images it could not open', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'anne://pages/about', 'mailto:a@b.c']) {
      expect(ids({ linkURL: url }), url).not.toContain('tab.open-link');
    }
    const img = contextMenuItems({ ...base, mediaType: 'image', srcURL: 'data:image/png;base64,AAAA', hasImageContents: true });
    expect(img.find((i) => 'id' in i && i.id === 'tab.open-image')).toMatchObject({ enabled: false });
    expect(img.find((i) => 'id' in i && i.id === 'file.save-image')).toMatchObject({ enabled: false });
    expect(img.find((i) => 'id' in i && i.id === 'edit.copy-image')).toMatchObject({ enabled: true, args: { x: 10, y: 21 } });
  });

  it('offers search for selected text, trimmed and bounded', () => {
    const items = contextMenuItems({ ...base, selectionText: `  ${'word '.repeat(400)}` });
    const search = items.find((i) => 'id' in i && i.id === 'page.search-selection') as unknown as { args: { text: string } };
    expect(search.args.text.length).toBe(1000);
    expect(ids({ selectionText: 'hello' })).toEqual(['edit.copy', 'page.search-selection', '-', 'tools.inspect-element']);
  });

  it('offers editing commands with the field’s own enabled states, and spelling suggestions', () => {
    const items = contextMenuItems({ ...base, isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten', 'tea', 'tech', 'tee', 'tel'] });
    const suggestions = items.filter((i) => 'id' in i && i.id === 'edit.replace-misspelling');
    expect(suggestions.map((i) => ('label' in i ? i.label : ''))).toEqual(['the', 'ten', 'tea', 'tech', 'tee']);
    expect(items.find((i) => 'id' in i && i.id === 'edit.paste')).toMatchObject({ enabled: true });
    expect(items.find((i) => 'id' in i && i.id === 'edit.cut')).toMatchObject({ enabled: false });
    const none = contextMenuItems({ ...base, isEditable: true, misspelledWord: 'zzxq' });
    expect(none[0]).toMatchObject({ label: 'No suggestions', enabled: false });
  });

  it('shows only editing commands inside the browser interface', () => {
    expect(ids({ inBrowserUi: true, isEditable: true })).toEqual(['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.paste', '-', 'edit.select-all']);
    expect(ids({ inBrowserUi: true })).toEqual([]);
  });

  it('only names commands that exist in the catalog with matching arguments', () => {
    const catalog = loadCatalog();
    expect(checkCatalog(catalog).errors).toEqual([]);
    const byId = new Map(catalog.commands.map((c) => [c.id, c]));
    const targets: Partial<ContextTarget>[] = [
      {}, { linkURL: 'https://e.example/' }, { mediaType: 'image', srcURL: 'https://e.example/i.png', hasImageContents: true },
      { selectionText: 'x' }, { isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the'] },
    ];
    for (const t of targets) {
      for (const item of contextMenuItems({ ...base, ...t })) {
        if ('separator' in item) continue;
        const record = byId.get(item.id);
        expect(record, item.id).toBeDefined();
        const required = (record!.args ?? []).filter((a) => !a.optional).map((a) => a.name).sort();
        const given = Object.keys(item.args ?? {}).sort();
        for (const name of required) expect(given, `${item.id} needs ${name}`).toContain(name);
        for (const name of given) expect((record!.args ?? []).map((a) => a.name), `${item.id} has no ${name}`).toContain(name);
      }
    }
  });
});
