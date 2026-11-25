import type { ExecuteRequest, WindowState } from '../core/ipc.ts';
import type { PaletteHit } from '../core/palette/search.ts';
import type { AnneApi } from '../preload/chrome.ts';

/**
 * Browser UI. Runs sandboxed with no privileges of its own: everything it
 * does is a request to the main process through `window.anne`.
 *
 * Page titles and URLs are attacker-controlled text. They are only ever
 * assigned through `textContent` and `value`; the page's content policy
 * (Trusted Types) makes any HTML-string assignment throw.
 */
declare global {
  interface Window { anne: AnneApi }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tabsEl = $('tabs');
const address = $<HTMLInputElement>('address');
const notice = $('notice');
const mode = $('mode');
const paletteEl = $('palette');
const paletteInput = $<HTMLInputElement>('palette-input');
const paletteList = $('palette-list');
const back = $<HTMLButtonElement>('back');
const forward = $<HTMLButtonElement>('forward');
const reload = $<HTMLButtonElement>('reload');

const run = (id: string, source: ExecuteRequest['source'] = 'toolbar', args?: ExecuteRequest['args']) =>
  void window.anne.execute({ id, source, ...(args && { args }) });

let state: WindowState | undefined;
let lastFocus = 0;
let lastTab: number | undefined;
/** The user has edited the address field and not yet submitted or cancelled. */
let typing = false;
let hits: PaletteHit[] = [];
let selected = 0;
let searchSeq = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

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

function apply(s: WindowState): void {
  const wasOpen = state?.paletteOpen ?? false;
  state = s;
  renderTabs(s);
  back.disabled = !s.canGoBack;
  forward.disabled = !s.canGoForward;
  reload.textContent = s.loading ? '×' : '↻';
  reload.title = s.loading ? 'Stop' : 'Reload';
  mode.hidden = !s.modal;
  notice.hidden = s.notice === undefined;
  notice.textContent = s.notice ?? '';
  // The field tracks the page unless the user has typed something not yet submitted.
  // Switching tabs discards such text.
  const activeTab = s.tabs.find((t) => t.active)?.id;
  if (activeTab !== lastTab) { lastTab = activeTab; typing = false; }
  if (!typing && address.value !== s.address) address.value = s.address;
  if (s.focusAddress !== lastFocus) {
    lastFocus = s.focusAddress;
    address.focus();
    address.select();
  }
  paletteEl.hidden = !s.paletteOpen;
  if (s.paletteOpen && !wasOpen) {
    paletteInput.value = '';
    paletteInput.focus();
    void search();
  }
}

back.addEventListener('click', () => run('nav.back'));
forward.addEventListener('click', () => run('nav.forward'));
reload.addEventListener('click', () => run(state?.loading ? 'nav.stop' : 'nav.reload'));
$('commands').addEventListener('click', () => run('app.command-palette'));

address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { typing = false; run('nav.go', 'toolbar', { text: address.value.slice(0, 8000) }); address.blur(); }
  else if (e.key === 'Escape') { typing = false; address.value = state?.address ?? ''; address.select(); }
});
address.addEventListener('focus', () => address.select());
address.addEventListener('input', () => { typing = true; });

paletteInput.addEventListener('input', () => void search());
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.anne.paletteClose();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (hits.length > 0) selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
    renderPalette();
  } else if (e.key === 'Enter') {
    const hit = hits[selected];
    if (hit) run(hit.id, 'palette');
  }
});
paletteEl.addEventListener('mousedown', (e) => { if (e.target === paletteEl) window.anne.paletteClose(); });

window.anne.onState(apply);
