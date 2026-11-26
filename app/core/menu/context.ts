/**
 * Which commands a context (right-click) menu offers, given what was
 * clicked. Pure: the platform adapter supplies the click details and turns
 * the result into a native menu, running each entry through the registry.
 *
 * Everything in `ContextTarget` that comes from a page (link, image and
 * selection text) is untrusted. It is only ever passed as a command
 * argument, where the registry checks its type and length and the handler
 * applies the navigation policy.
 */

export interface ContextTarget {
  x: number;
  y: number;
  linkURL: string;
  srcURL: string;
  mediaType: string;
  hasImageContents: boolean;
  selectionText: string;
  isEditable: boolean;
  misspelledWord: string;
  dictionarySuggestions: readonly string[];
  editFlags: {
    canUndo: boolean; canRedo: boolean; canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean;
  };
  /** The click was in the browser's own interface, not in a page. */
  inBrowserUi: boolean;
}

export type ContextItem =
  | { separator: true }
  | { id: string; args?: Record<string, string | number>; label?: string; enabled?: boolean };

const SEP: ContextItem = { separator: true };
const MAX_SELECTION = 1000;
const MAX_SUGGESTIONS = 5;

/** Only these link and image addresses are offered for opening and saving. */
function isOpenable(url: string): boolean {
  return /^(https?|gopher|file):/i.test(url) && url.length <= 8192;
}

function trimSeparators(items: ContextItem[]): ContextItem[] {
  const out: ContextItem[] = [];
  for (const it of items) {
    if ('separator' in it && (out.length === 0 || 'separator' in out.at(-1)!)) continue;
    out.push(it);
  }
  while (out.length > 0 && 'separator' in out.at(-1)!) out.pop();
  return out;
}

export function contextMenuItems(t: ContextTarget): ContextItem[] {
  const items: ContextItem[] = [];
  const x = Math.round(t.x);
  const y = Math.round(t.y);

  if (t.isEditable) {
    if (t.misspelledWord) {
      const suggestions = t.dictionarySuggestions.filter((s) => s.length > 0 && s.length <= 100).slice(0, MAX_SUGGESTIONS);
      for (const s of suggestions) items.push({ id: 'edit.replace-misspelling', args: { text: s }, label: s });
      if (suggestions.length === 0) items.push({ id: 'edit.replace-misspelling', args: { text: '' }, label: 'No suggestions', enabled: false });
      items.push(SEP);
    }
    const f = t.editFlags;
    items.push(
      { id: 'edit.undo', enabled: f.canUndo }, { id: 'edit.redo', enabled: f.canRedo }, SEP,
      { id: 'edit.cut', enabled: f.canCut }, { id: 'edit.copy', enabled: f.canCopy }, { id: 'edit.paste', enabled: f.canPaste }, SEP,
      { id: 'edit.select-all', enabled: f.canSelectAll },
    );
    if (t.inBrowserUi) return trimSeparators(items);
    items.push(SEP);
  } else if (t.inBrowserUi) {
    return [];
  }

  if (t.linkURL && isOpenable(t.linkURL)) {
    items.push(
      { id: 'tab.open-link', args: { url: t.linkURL } },
      { id: 'file.save-link', args: { url: t.linkURL }, enabled: /^https?:/i.test(t.linkURL) },
      { id: 'edit.copy-link', args: { url: t.linkURL } },
      SEP,
    );
  }

  if (t.mediaType === 'image' && t.srcURL) {
    const src = t.srcURL;
    items.push(
      { id: 'tab.open-image', args: { url: src }, enabled: isOpenable(src) },
      { id: 'file.save-image', args: { url: src }, enabled: /^https?:/i.test(src) },
      { id: 'edit.copy-image', args: { x, y }, enabled: t.hasImageContents },
      SEP,
    );
  }

  const selection = t.selectionText.trim().slice(0, MAX_SELECTION);
  if (selection && !t.isEditable) {
    items.push({ id: 'edit.copy' }, { id: 'page.search-selection', args: { text: selection } }, SEP);
  }

  if (!t.linkURL && t.mediaType !== 'image' && !selection && !t.isEditable) {
    items.push(
      { id: 'nav.back' }, { id: 'nav.forward' }, { id: 'nav.reload' }, SEP,
      { id: 'bookmark.toggle' }, { id: 'file.save-page-as' }, { id: 'file.print' }, SEP,
      { id: 'view.page-source' }, { id: 'page.info' }, SEP,
    );
  }

  items.push({ id: 'tools.inspect-element', args: { x, y } });
  return trimSeparators(items);
}
