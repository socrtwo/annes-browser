import { BaseWindow, dialog, type Input, shell, type WebContents, WebContentsView } from 'electron';
import type { Catalog } from '../core/catalog/types.ts';
import type { SettingsStore } from '../core/data/settings.ts';
import type { UrlStore } from '../core/data/url-store.ts';
import { IPC, type FindState, type Overlay, type WindowState } from '../core/ipc.ts';
import { chordFromInput, isTypingChord, type OS } from '../core/keys/chord.ts';
import { displayBinding, KeyDispatcher, type KeyResult, resolveKeymap, type ResolvedBinding } from '../core/keys/resolver.ts';
import type { ContextTarget } from '../core/menu/context.ts';
import { permissionLabel } from '../core/security/permissions.ts';
import {
  CHROME_ORIGIN, decideFrameNavigation, decideNavigation, displayUrl, type Initiator, interpretAddressInput,
  type NavigationDecision, PAGES_ORIGIN, RUFFLE_BASE, searchUrl,
} from '../core/security/url-policy.ts';
import type { Context } from '../core/when/when.ts';
import { adopt, flashTabs, uiPreferences, webPreferences } from './security.ts';

/** Heights in the UI view; they must match app/ui/chrome.css. */
const TOOLBAR_HEIGHT = 76;
const FIND_HEIGHT = 36;
const NOTICE_HEIGHT = 28;
const SEQUENCE_TIMEOUT_MS = 1000;
const MAX_CLOSED = 25;
const MAX_FIND_TEXT = 1000;
export const HOME_URL = `${PAGES_ORIGIN}/home`;

interface Tab {
  id: number;
  view: WebContentsView;
}

export interface WindowHost {
  catalog: Catalog;
  os: OS;
  preload: string;
  settings: SettingsStore;
  bookmarks: UrlStore;
  history: UrlStore;
  /** Counter that changes whenever bookmarks, history or downloads change. */
  listVersion(): number;
  downloadCount(): number;
  /** Run a catalog command for this window. */
  execute(win: BrowserWindow, id: string, source: 'key' | 'internal', args?: Record<string, unknown>): void;
  /** Show the context menu for a click in this window. */
  contextMenu(win: BrowserWindow, target: ContextTarget): void;
  /** The window's context changed: menus and UI state need refreshing. */
  changed(win: BrowserWindow): void;
  closed(win: BrowserWindow): void;
}

export interface WindowOptions {
  partition: string;
  isPrivate: boolean;
}

let nextTabId = 1;

/** One browser window: the UI view on top, one view per tab below it. */
export class BrowserWindow {
  readonly win: BaseWindow;
  readonly ui: WebContentsView;
  readonly partition: string;
  readonly isPrivate: boolean;
  private readonly tabs: Tab[] = [];
  private active: Tab | undefined;
  private readonly closed: string[] = [];
  private readonly keys: KeyDispatcher;
  private bindings: ResolvedBinding[];
  private sequenceTimer: NodeJS.Timeout | undefined;
  private noticeTimer: NodeJS.Timeout | undefined;
  private notice: string | undefined;
  private focusAddress = 0;
  private focusFind = 0;
  private externalPromptOpen = false;
  /** Permission prompts are shown one at a time. */
  private promptQueue: Promise<unknown> = Promise.resolve();
  private findOpen = false;
  private findText = '';
  private findResult: FindState = {};
  /** The tab the current find session belongs to. */
  private findTab: Tab | undefined;
  overlay: Overlay | undefined;
  modal = false;
  layout: string;
  keymap: string;

  private readonly host: WindowHost;

  constructor(host: WindowHost, options: WindowOptions) {
    this.host = host;
    this.partition = options.partition;
    this.isPrivate = options.isPrivate;
    const settings = host.settings.get();
    this.layout = settings.layout;
    this.keymap = settings.keymap;
    this.win = new BaseWindow({
      width: 1200, height: 800, minWidth: 480, minHeight: 320, show: false,
      title: this.isPrivate ? "Anne's Browser (Private)" : "Anne's Browser",
    });
    this.ui = new WebContentsView({ webPreferences: uiPreferences(host.preload) });
    this.ui.setBackgroundColor('#00000000');
    adopt(this.ui.webContents);
    this.win.contentView.addChildView(this.ui);

    this.bindings = resolveKeymap(host.catalog.keymaps, this.keymap, host.os);
    this.keys = new KeyDispatcher(this.bindings);

    // The UI never navigates and never opens windows.
    this.ui.webContents.on('will-navigate', (e) => e.preventDefault());
    this.ui.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.ui.webContents.on('before-input-event', (event, input) => this.onKey(event, input, false));
    this.ui.webContents.on('context-menu', (_e, params) => host.contextMenu(this, toTarget(params, true)));
    void this.ui.webContents.loadURL(`${CHROME_ORIGIN}/index.html`);

    this.win.on('resize', () => this.relayout());
    this.win.on('enter-full-screen', () => this.changed());
    this.win.on('leave-full-screen', () => this.changed());
    this.win.on('closed', () => {
      clearTimeout(this.sequenceTimer);
      clearTimeout(this.noticeTimer);
      for (const t of this.tabs) t.view.webContents.close();
      this.ui.webContents.close();
      host.closed(this);
    });
    this.relayout();
    this.win.show();
  }

  // ---- state ----

  get activeContents(): WebContents | undefined {
    return this.active?.view.webContents;
  }

  get paletteOpen(): boolean {
    return this.overlay === 'palette';
  }

  /** True if `wc` is one of this window's tabs or its UI. */
  owns(wc: WebContents): boolean {
    return wc === this.ui.webContents || this.tabs.some((t) => t.view.webContents === wc);
  }

  /** True if `wc` is this window's UI and the sender is its top frame at the UI origin. */
  isUiSender(wc: WebContents, frameUrl: string | undefined, isMainFrame: boolean): boolean {
    return wc === this.ui.webContents && isMainFrame && frameUrl !== undefined && frameUrl.startsWith(`${CHROME_ORIGIN}/`);
  }

  private pageUrl(): string {
    return this.activeContents?.getURL() ?? '';
  }

  context(): Context {
    const wc = this.activeContents;
    let scheme = '';
    try { scheme = wc ? new URL(wc.getURL()).protocol.slice(0, -1) : ''; } catch { /* no page yet */ }
    return {
      'tab.count': this.tabs.length,
      'tab.canGoBack': wc?.navigationHistory.canGoBack() ?? false,
      'tab.canGoForward': wc?.navigationHistory.canGoForward() ?? false,
      'tab.isLoading': wc?.isLoadingMainFrame() ?? false,
      'tab.hasClosed': this.closed.length > 0,
      'page.scheme': scheme,
      'page.zoom': wc?.getZoomFactor() ?? 1,
      'page.isBookmarked': wc ? this.host.bookmarks.has(wc.getURL()) : false,
      'window.isFullScreen': this.win.isFullScreen(),
      'window.isPrivate': this.isPrivate,
      'input.modal': this.modal,
      'ui.paletteOpen': this.paletteOpen,
      'ui.overlay': this.overlay ?? '',
      'ui.findOpen': this.findOpen,
      'ui.layout': this.layout,
      'ui.keymap': this.keymap,
      'downloads.count': this.host.downloadCount(),
    };
  }

  state(): WindowState {
    const wc = this.activeContents;
    const url = wc?.getURL() ?? '';
    return {
      tabs: this.tabs.map((t) => ({
        id: t.id,
        title: (t.view.webContents.getTitle() || 'New Tab').slice(0, 200),
        active: t === this.active,
        loading: t.view.webContents.isLoadingMainFrame(),
      })),
      address: wc && url !== HOME_URL ? displayUrl(url) : '',
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      loading: wc?.isLoadingMainFrame() ?? false,
      ...(this.overlay !== undefined && { overlay: this.overlay }),
      ...(this.findOpen && { find: { ...this.findResult } }),
      focusFind: this.focusFind,
      listVersion: this.host.listVersion(),
      isPrivate: this.isPrivate,
      isBookmarked: wc ? this.host.bookmarks.has(url) : false,
      modal: this.modal,
      focusAddress: this.focusAddress,
      ...(this.notice !== undefined && { notice: this.notice }),
    };
  }

  sendState(): void {
    if (!this.ui.webContents.isDestroyed()) this.ui.webContents.send(IPC.state, this.state());
  }

  private changed(): void {
    this.host.changed(this);
  }

  keysFor(command: string): string[] | undefined {
    return displayBinding(this.bindings, command);
  }

  setKeymap(id: string): void {
    this.bindings = resolveKeymap(this.host.catalog.keymaps, id, this.host.os);
    this.keys.setBindings(this.bindings);
    this.keymap = id;
    if (!this.bindings.some((b) => b.when?.includes('input.modal'))) this.modal = false;
    this.changed();
  }

  setLayout(id: string): void {
    this.layout = id;
    this.changed();
  }

  setModal(on: boolean): void {
    this.modal = on;
    this.keys.reset();
    if (on) this.activeContents?.focus();
    this.changed();
  }

  showNotice(text: string): void {
    this.notice = text.slice(0, 300);
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.notice = undefined; this.relayout(); this.sendState(); }, 6000);
    this.relayout();
    this.sendState();
  }

  clearClosedTabs(): void {
    this.closed.length = 0;
    this.changed();
  }

  // ---- layout ----

  private relayout(): void {
    if (this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    const top = TOOLBAR_HEIGHT + (this.findOpen ? FIND_HEIGHT : 0) + (this.notice ? NOTICE_HEIGHT : 0);
    // While an overlay is open the UI covers the page; otherwise it is only the toolbar strip.
    this.ui.setBounds({ x: 0, y: 0, width, height: this.overlay ? height : top });
    this.active?.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }

  /** Open an overlay (palette or a list panel), or close it with `undefined`. */
  setOverlay(overlay: Overlay | undefined): void {
    if (this.overlay === overlay) return;
    this.overlay = overlay;
    if (overlay) {
      this.win.contentView.addChildView(this.ui); // re-adding raises it above the tab
      this.ui.webContents.focus();
    } else {
      this.activeContents?.focus();
    }
    this.relayout();
    this.changed();
  }

  /** Open the overlay, or close it if it is already the one showing. */
  toggleOverlay(overlay: Overlay): void {
    this.setOverlay(this.overlay === overlay ? undefined : overlay);
  }

  focusAddressBar(): void {
    this.focusAddress++;
    this.ui.webContents.focus();
    this.sendState();
  }

  // ---- find in page ----

  openFind(): void {
    this.findOpen = true;
    this.focusFind++;
    this.ui.webContents.focus();
    this.relayout();
    this.changed();
  }

  /** Search the active tab. With no text, repeat the last search, or open the find bar if there is none. */
  find(text: string | undefined, forward: boolean): void {
    const wc = this.activeContents;
    if (!wc) return;
    const query = (text ?? this.findText).slice(0, MAX_FIND_TEXT);
    if (text === undefined && query === '') return this.openFind();
    if (!this.findOpen) { this.findOpen = true; this.relayout(); }
    if (query === '') {
      wc.stopFindInPage('clearSelection');
      this.findText = '';
      this.findResult = {};
      this.changed();
      return;
    }
    // Electron's `findNext: true` starts a new search session; follow-up requests step through matches.
    const newSession = query !== this.findText || this.findTab !== this.active;
    this.findText = query;
    this.findTab = this.active;
    wc.findInPage(query, { forward, findNext: newSession, matchCase: false });
    this.changed();
  }

  closeFind(): void {
    if (!this.findOpen) return;
    this.findTab?.view.webContents.stopFindInPage('keepSelection');
    this.findOpen = false;
    this.findResult = {};
    this.findTab = undefined;
    this.activeContents?.focus();
    this.relayout();
    this.changed();
  }

  // ---- tabs ----

  newTab(url: string = this.host.settings.get().homePage, initiator: Initiator = 'internal', from?: string): void {
    // A tab requested by page content is created only if its address is allowed; otherwise the
    // refusal (notice, external-app prompt or command) happens without leaving an empty tab behind.
    if (initiator === 'web-content') {
      const decision = decideNavigation({ url, initiator, ...(from !== undefined && { from }) });
      if (decision.action !== 'allow') return this.handleRefused(decision, url, initiator);
    }
    const view = new WebContentsView({ webPreferences: webPreferences(this.partition) });
    const tab: Tab = { id: nextTabId++, view };
    const wc = view.webContents;
    adopt(wc);
    this.guard(wc, tab);
    this.tabs.push(tab);
    this.select(tab);
    this.navigate(url, initiator, from, wc);
  }

  private select(tab: Tab): void {
    const previous = this.active;
    if (previous && previous !== tab) {
      this.win.contentView.removeChildView(previous.view);
      if (this.findTab === previous) previous.view.webContents.stopFindInPage('keepSelection');
    }
    this.active = tab;
    this.win.contentView.addChildView(tab.view, 0);
    this.relayout();
    if (!this.overlay) tab.view.webContents.focus();
    // An open find bar follows the user to the new tab.
    if (this.findOpen && this.findText && previous !== tab) {
      this.findResult = {};
      this.find(this.findText, true);
    }
    this.changed();
  }

  selectIndex(index: number): void {
    const tab = this.tabs[index];
    if (tab) this.select(tab);
  }

  cycle(delta: number): void {
    if (!this.active || this.tabs.length < 2) return;
    const i = (this.tabs.indexOf(this.active) + delta + this.tabs.length) % this.tabs.length;
    this.select(this.tabs[i]!);
  }

  closeTab(index = this.active ? this.tabs.indexOf(this.active) : -1): void {
    const tab = this.tabs[index];
    if (!tab) return;
    const url = tab.view.webContents.getURL();
    if (url && url !== HOME_URL) {
      this.closed.push(url);
      if (this.closed.length > MAX_CLOSED) this.closed.shift();
    }
    if (this.findTab === tab) this.findTab = undefined;
    this.tabs.splice(index, 1);
    this.win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    if (this.tabs.length === 0) { this.active = undefined; this.win.close(); return; }
    if (tab === this.active) this.select(this.tabs[Math.min(index, this.tabs.length - 1)]!);
    else this.changed();
  }

  reopenClosed(): void {
    const url = this.closed.pop();
    // The address was reached by the user earlier; it still passes through the policy.
    if (url) this.newTab(url, 'user-command');
  }

  // ---- navigation ----

  /** Interpret address-bar or command text and load it in the active tab. */
  go(text: string): void {
    const input = interpretAddressInput(text);
    if (input.kind === 'empty') return;
    const url = input.kind === 'url' ? input.url : searchUrl(this.host.settings.get().searchTemplate, input.query);
    this.navigate(url, 'user-typed');
    this.activeContents?.focus();
  }

  /** The only way a URL chosen by this process gets loaded. Applies the navigation policy. */
  navigate(url: string, initiator: Initiator, from?: string, target: WebContents | undefined = this.activeContents): void {
    if (!target) return this.newTab(url, initiator, from);
    const decision = decideNavigation({ url, initiator, ...(from !== undefined && { from }) });
    if (decision.action === 'allow') {
      target.loadURL(decision.url).catch(() => { /* failures are reported by did-fail-load */ });
      return;
    }
    this.handleRefused(decision, url, initiator, target);
  }

  /** What happens to a navigation the policy did not simply allow. */
  private handleRefused(decision: NavigationDecision, url: string, initiator: Initiator, target?: WebContents): void {
    switch (decision.action) {
      case 'allow':
        return;
      case 'command':
        this.host.execute(this, decision.command, 'internal', { url: decision.url });
        break;
      case 'external':
        void this.openExternal(decision.url, decision.scheme);
        break;
      case 'deny':
        if (initiator === 'web-content' || !target) this.showNotice(`Blocked: ${decision.reason}`);
        else void target.loadURL(`${PAGES_ORIGIN}/blocked?${new URLSearchParams({ url: url.slice(0, 500), reason: decision.reason })}`);
    }
  }

  private async openExternal(url: string, scheme: string): Promise<void> {
    // One prompt at a time, so a page cannot bury the user in dialogs.
    if (this.externalPromptOpen) return;
    this.externalPromptOpen = true;
    try {
      const { response } = await dialog.showMessageBox(this.win, {
        type: 'question',
        buttons: ['Cancel', 'Open'],
        defaultId: 0,
        cancelId: 0,
        message: `Open this ${scheme} link in another application?`,
        detail: url.slice(0, 300),
      });
      if (response === 1) await shell.openExternal(url);
    } finally {
      this.externalPromptOpen = false;
    }
  }

  // ---- permissions ----

  /**
   * Ask the user about a site permission. The origin shown is the one the
   * main process computed, never text supplied by the page. Prompts queue,
   * so a page cannot stack dialogs.
   */
  askPermission(origin: string, permission: string): Promise<boolean> {
    const ask = this.promptQueue.then(async () => {
      if (this.win.isDestroyed()) return false;
      const { response } = await dialog.showMessageBox(this.win, {
        type: 'question',
        buttons: ['Block', 'Allow'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Permission request',
        message: `${origin} wants to ${permissionLabel(permission)}.`,
        detail: this.isPrivate
          ? 'Your answer applies until this private window closes.'
          : 'Your answer applies to this site until you quit the browser or clear browsing data.',
      });
      return response === 1;
    });
    this.promptQueue = ask.catch(() => false);
    return ask;
  }

  // ---- Flash emulation ----

  /**
   * Turn the Ruffle emulator on for the active tab. It stays on for that tab
   * until the tab closes. The emulator runs inside the page, with the page's
   * own privileges and nothing more: it gets no bridge to the browser.
   */
  enableFlash(): void {
    const wc = this.activeContents;
    if (!wc) return;
    if (!/^https?:/.test(wc.getURL())) return this.showNotice('Flash emulation works on web pages only.');
    if (!flashTabs.has(wc.id)) {
      const id = wc.id;
      flashTabs.add(id);
      wc.once('destroyed', () => flashTabs.delete(id));
      wc.on('dom-ready', () => this.injectRuffle(wc));
    }
    this.injectRuffle(wc);
    this.showNotice('Flash emulation (Ruffle) is on for this tab.');
  }

  private injectRuffle(wc: WebContents): void {
    if (wc.isDestroyed() || !flashTabs.has(wc.id) || !/^https?:/.test(wc.getURL())) return;
    // A constant script: nothing from the page or the user is interpolated into it.
    const script = `(() => {
      if (window.__anneRuffle) return 'present';
      window.__anneRuffle = true;
      window.RufflePlayer = window.RufflePlayer || {};
      window.RufflePlayer.config = Object.assign({ publicPath: ${JSON.stringify(RUFFLE_BASE)}, polyfills: true, autoplay: 'auto', openUrlMode: 'confirm', allowNetworking: 'all' }, window.RufflePlayer.config || {});
      const s = document.createElement('script');
      s.src = ${JSON.stringify(`${RUFFLE_BASE}ruffle.js`)};
      (document.head || document.documentElement).append(s);
      return 'injected';
    })()`;
    wc.executeJavaScript(script).catch(() => this.showNotice('This page does not allow the Flash emulator to load.'));
  }

  // ---- page events ----

  /** Attach the navigation, window-open, history and key rules to a tab. */
  private guard(wc: WebContents, tab: Tab): void {
    const check = (event: { preventDefault(): void }, url: string, isMainFrame: boolean) => {
      if (!isMainFrame) {
        if (decideFrameNavigation(url, wc.getURL()).action !== 'allow') event.preventDefault();
        return;
      }
      const decision = decideNavigation({ url, initiator: 'web-content', from: wc.getURL() });
      if (decision.action === 'allow') return;
      event.preventDefault();
      // Route the refused navigation through the same path as everything else (prompt, command or notice).
      this.navigate(url, 'web-content', wc.getURL(), wc);
    };
    wc.on('will-frame-navigate', (details) => check(details, details.url, details.isMainFrame));
    wc.on('will-redirect', (details) => check(details, details.url, details.isMainFrame));
    wc.setWindowOpenHandler(({ url }) => {
      // Pop-ups become tabs, subject to the same policy; the engine never creates a window itself.
      const from = wc.getURL();
      if (decideNavigation({ url, initiator: 'web-content', from }).action === 'allow') {
        setImmediate(() => { if (!this.win.isDestroyed()) this.newTab(url, 'web-content', from); });
      }
      return { action: 'deny' };
    });
    wc.on('before-input-event', (event, input) => this.onKey(event, input, true));
    wc.on('context-menu', (_e, params) => {
      if (tab === this.active) this.host.contextMenu(this, toTarget(params, false));
    });

    // History: main-frame loads only, never in private windows.
    wc.on('did-navigate', (_e, url, httpResponseCode) => {
      if (!this.isPrivate && httpResponseCode < 400) this.host.history.visit(url, wc.getTitle(), Date.now());
    });
    wc.on('page-title-updated', (_e, title) => {
      if (!this.isPrivate) this.host.history.setTitle(wc.getURL(), title);
    });

    wc.on('found-in-page', (_e, result) => {
      if (tab !== this.findTab) return;
      this.findResult = { matches: result.matches, active: result.activeMatchOrdinal };
      this.changed();
    });
    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) {
      wc.on(ev as 'did-stop-loading', () => this.changed());
    }
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 is a cancelled load (including ones this policy cancelled).
      if (isMainFrame && code !== -3) this.showNotice(`Could not load ${displayUrl(url).slice(0, 120)}: ${description}`);
    });
    wc.on('render-process-gone', (_e, details) => this.showNotice(`A page stopped working (${details.reason}).`));
  }

  // ---- keys ----

  private onKey(event: { preventDefault(): void }, input: Input, fromPage: boolean): void {
    if (input.type !== 'keyDown') return;
    const chord = chordFromInput(input);
    if (!chord) return;
    // Modal single-key commands apply to the page, never to typing in the browser's own fields.
    const ctx = fromPage ? this.context() : { ...this.context(), 'input.modal': false };
    clearTimeout(this.sequenceTimer);
    const result = this.keys.press(chord, ctx);
    if (result.kind === 'pending') {
      event.preventDefault();
      this.sequenceTimer = setTimeout(() => this.run(this.keys.timeout(this.context())), SEQUENCE_TIMEOUT_MS);
    } else if (result.kind === 'execute') {
      event.preventDefault();
      this.run(result);
    } else if (fromPage && this.modal && isTypingChord(chord)) {
      event.preventDefault(); // in modal mode, typing never reaches the page
    }
  }

  private run(result: KeyResult): void {
    if (result.kind === 'execute') this.host.execute(this, result.command, 'key', result.args);
  }
}

/** Copy the fields the context menu needs out of Electron's event parameters. */
function toTarget(p: Electron.ContextMenuParams, inBrowserUi: boolean): ContextTarget {
  return {
    x: p.x, y: p.y, linkURL: p.linkURL, srcURL: p.srcURL, mediaType: p.mediaType, hasImageContents: p.hasImageContents,
    selectionText: p.selectionText, isEditable: p.isEditable, misspelledWord: p.misspelledWord,
    dictionarySuggestions: p.dictionarySuggestions, inBrowserUi,
    editFlags: {
      canUndo: p.editFlags.canUndo, canRedo: p.editFlags.canRedo, canCut: p.editFlags.canCut,
      canCopy: p.editFlags.canCopy, canPaste: p.editFlags.canPaste, canSelectAll: p.editFlags.canSelectAll,
    },
  };
}
