import type { ExecuteRequest, ListItem, ListKind, WindowState } from '../core/ipc.ts';
import type { PaletteHit } from '../core/palette/search.ts';
import type { AnneApi } from '../preload/chrome.ts';

/**
 * Browser UI. Runs sandboxed with no privileges of its own: everything it
 * does is a request to the main process through `window.anne`.
 *
 * Page titles, URLs, bookmark and history entries and download names are
 * attacker-controlled text. They are only ever assigned through
 * `textContent` and `value`; the page's content policy (Trusted Types)
 * makes any HTML-string assignment throw.
 */
declare global {
  interface Window { anne: AnneApi }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tabsEl = $('tabs');
const address = $<HTMLInputElement>('address');
const notice = $('notice');
const mode = $('mode');
const privateBadge = $('private-badge');
const star = $<HTMLButtonElement>('star');
const back = $<HTMLButtonElement>('back');
const forward = $<HTMLButtonElement>('forward');
const reload = $<HTMLButtonElement>('reload');
const findBar = $('find');
const findInput = $<HTMLInputElement>('find-input');
const findCount = $('find-count');
const paletteEl = $('palette');
const paletteInput = $<HTMLInputElement>('palette-input');
const paletteList = $('palette-list');
const panelEl = $('panel');
const panelTitle = $('panel-title');
const panelInput = $<HTMLInputElement>('panel-input');
const panelList = $('panel-list');
const panelEmpty = $('panel-empty');
const panelClear = $<HTMLButtonElement>('panel-clear');

type Args = ExecuteRequest['args'];
const run = (id: string, source: ExecuteRequest['source'] = 'toolbar', args?: Args) =>
  void window.anne.execute({ id, source, ...(args && { args }) });

let state: WindowState | undefined;
let lastFocus = 0;
let lastFindFocus = 0;
let lastTab: number | undefined;
/** The user has edited the address field and not yet submitted or cancelled. */
let typing = false;
let hits: PaletteHit[] = [];
let selected = 0;
let searchSeq = 0;
let listSeq = 0;
let shownListVersion = -1;
let shownPanel: ListKind | undefined;

const PANEL_TITLES: Record<ListKind, string> = { bookmarks: 'Bookmarks', history: 'History', downloads: 'Downloads' };
const isListKind = (o: string | undefined): o is ListKind => o === 'bookmarks' || o === 'history' || o === 'downloads';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---- tabs ----

function renderTabs(s: WindowState): void {
  const nodes = s.tabs.map((tab, i) => {
    const node = el('div', `tab${tab.active ? ' active' : ''}${tab.loading ? ' loading' : ''}`);
    node.setAttribute('role', 'tab');
    node.setAttribute('aria-selected', String(tab.active));
    node.title = tab.title;
    node.append(el('span', 'title', tab.title));
    const close = el('button', 'close', '×');
    close.setAttribute('aria-label', 'Close tab');
    close.addEventListener('click', (e) => { e.stopPropagation(); run('tab.close', 'toolbar', { index: i + 1 }); });
    node.append(close);
    node.addEventListener('click', () => run('tab.select', 'toolbar', { index: i + 1 }));
    node.addEventListener('auxclick', (e) => { if (e.button === 1) run('tab.close', 'toolbar', { index: i + 1 }); });
    return node;
  });
  const add = el('button', '', '+');
  add.id = 'newtab';
  add.title = 'New tab';
  add.addEventListener('click', () => run('tab.new'));
  tabsEl.replaceChildren(...nodes, add);
}

// ---- palette ----

function renderPalette(): void {
  paletteList.replaceChildren(...hits.map((hit, i) => {
    const li = el('li', i === selected ? 'sel' : '');
    li.setAttribute('role', 'option');
    li.append(el('span', '', hit.label));
    if (hit.via) li.append(el('span', 'via', hit.via));
    li.addEventListener('click', () => run(hit.id, 'palette'));
    return li;
  }));
  paletteList.children[selected]?.scrollIntoView({ block: 'nearest' });
}

async function search(): Promise<void> {
  const seq = ++searchSeq;
  const result = (await window.anne.paletteSearch(paletteInput.value)) as PaletteHit[];
  if (seq !== searchSeq) return; // a newer search is already under way
  hits = Array.isArray(result) ? result : [];
  selected = 0;
  renderPalette();
}

// ---- list panels (bookmarks, history, downloads) ----

function renderList(items: ListItem[]): void {
  panelEmpty.hidden = items.length > 0;
  panelList.replaceChildren(...items.map((item) => {
    const li = el('li', '');
    const text = el('span', `text${item.open ? ' openable' : ''}`);
    text.append(el('span', 'title', item.title), el('span', 'url', item.url));
    if (item.detail) text.append(el('span', 'detail', item.detail));
    if (item.open) {
      const open = item.open;
      text.addEventListener('click', () => run(open, 'toolbar', { id: item.id }));
    }
    li.append(text);
    if (item.secondary) {
      const { command, label } = item.secondary;
      const b = el('button', '', label);
      b.addEventListener('click', () => run(command, 'toolbar', { id: item.id }));
      li.append(b);
    }
    if (item.remove) {
      const remove = item.remove;
      const b = el('button', 'remove', '×');
      b.title = 'Remove';
      b.setAttribute('aria-label', `Remove ${item.title}`);
      b.addEventListener('click', () => run(remove, 'toolbar', { id: item.id }));
      li.append(b);
    }
    return li;
  }));
}

async function loadList(): Promise<void> {
  if (!isListKind(state?.overlay)) return;
  const kind = state.overlay;
  const seq = ++listSeq;
  const items = (await window.anne.list({ kind, query: panelInput.value.slice(0, 200) })) as ListItem[];
  if (seq !== listSeq || state?.overlay !== kind) return;
  renderList(Array.isArray(items) ? items : []);
}

// ---- state ----

function apply(s: WindowState): void {
  const previousOverlay = state?.overlay;
  state = s;
  document.body.classList.toggle('private', s.isPrivate);
  privateBadge.hidden = !s.isPrivate;
  renderTabs(s);
  back.disabled = !s.canGoBack;
  forward.disabled = !s.canGoForward;
  reload.textContent = s.loading ? '×' : '↻';
  reload.title = s.loading ? 'Stop' : 'Reload';
  star.textContent = s.isBookmarked ? '★' : '☆';
  star.setAttribute('aria-pressed', String(s.isBookmarked));
  star.title = s.isBookmarked ? 'Remove bookmark' : 'Bookmark this page';
  mode.hidden = !s.modal;
  notice.hidden = s.notice === undefined;
  notice.textContent = s.notice ?? '';

  // The address field tracks the page unless the user has typed something not yet submitted.
  // Switching tabs discards such text.
  const activeTab = s.tabs.find((t) => t.active)?.id;
  if (activeTab !== lastTab) { lastTab = activeTab; typing = false; }
  if (!typing && address.value !== s.address) address.value = s.address;
  if (s.focusAddress !== lastFocus) {
    lastFocus = s.focusAddress;
    address.focus();
    address.select();
  }

  // Find bar.
  findBar.hidden = s.find === undefined;
  if (s.find) {
    const { matches, active } = s.find;
    findCount.textContent = matches === undefined || findInput.value === '' ? '' : matches === 0 ? 'No matches' : `${active ?? 0} of ${matches}`;
    findInput.classList.toggle('none', matches === 0 && findInput.value !== '');
  }
  if (s.focusFind !== lastFindFocus) {
    lastFindFocus = s.focusFind;
    findInput.focus();
    findInput.select();
  }

  // Palette.
  paletteEl.hidden = s.overlay !== 'palette';
  if (s.overlay === 'palette' && previousOverlay !== 'palette') {
    paletteInput.value = '';
    paletteInput.focus();
    void search();
  }

  // List panel.
  panelEl.hidden = !isListKind(s.overlay);
  if (isListKind(s.overlay)) {
    if (shownPanel !== s.overlay) {
      shownPanel = s.overlay;
      panelTitle.textContent = PANEL_TITLES[s.overlay];
      panelInput.value = '';
      panelInput.placeholder = `Search ${PANEL_TITLES[s.overlay].toLowerCase()}`;
      panelClear.hidden = s.overlay !== 'downloads';
      panelList.replaceChildren();
      panelInput.focus();
      shownListVersion = -1;
    }
    if (shownListVersion !== s.listVersion) {
      shownListVersion = s.listVersion;
      void loadList();
    }
  } else {
    shownPanel = undefined;
  }
}

// ---- events ----

back.addEventListener('click', () => run('nav.back'));
forward.addEventListener('click', () => run('nav.forward'));
reload.addEventListener('click', () => run(state?.loading ? 'nav.stop' : 'nav.reload'));
star.addEventListener('click', () => run('bookmark.toggle'));
$('downloads').addEventListener('click', () => run('tools.downloads'));
$('commands').addEventListener('click', () => run('app.command-palette'));

address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { typing = false; run('nav.go', 'toolbar', { text: address.value.slice(0, 8000) }); address.blur(); }
  else if (e.key === 'Escape') { typing = false; address.value = state?.address ?? ''; address.select(); }
});
address.addEventListener('focus', () => address.select());
address.addEventListener('input', () => { typing = true; });

findInput.addEventListener('input', () => run('edit.find-next', 'toolbar', { text: findInput.value.slice(0, 1000) }));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') run(e.shiftKey ? 'edit.find-previous' : 'edit.find-next', 'toolbar', { text: findInput.value.slice(0, 1000) });
  else if (e.key === 'Escape') run('edit.find-close');
});
$('find-next').addEventListener('click', () => run('edit.find-next', 'toolbar', { text: findInput.value.slice(0, 1000) }));
$('find-prev').addEventListener('click', () => run('edit.find-previous', 'toolbar', { text: findInput.value.slice(0, 1000) }));
$('find-close').addEventListener('click', () => run('edit.find-close'));

paletteInput.addEventListener('input', () => void search());
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.anne.closeOverlay();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (hits.length > 0) selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
    renderPalette();
  } else if (e.key === 'Enter') {
    const hit = hits[selected];
    if (hit) run(hit.id, 'palette');
  }
});

panelInput.addEventListener('input', () => void loadList());
panelInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.anne.closeOverlay(); });
panelClear.addEventListener('click', () => run('tools.downloads-clear'));
$('panel-close').addEventListener('click', () => window.anne.closeOverlay());

for (const overlay of [paletteEl, panelEl]) {
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) window.anne.closeOverlay(); });
}

window.anne.onState(apply);
