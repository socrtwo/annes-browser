import { pathToFileURL } from 'node:url';
import { app, clipboard, dialog, webContents } from 'electron';
import { isValidHomePage, SEARCH_ENGINES, type SettingsStore } from '../core/data/settings.ts';
import type { UrlStore } from '../core/data/url-store.ts';
import type { CommandRegistry } from '../core/registry.ts';
import { sanitizeFilename } from '../core/security/downloads.ts';
import { displayUrl, PAGES_ORIGIN, searchUrl } from '../core/security/url-policy.ts';
import type { Downloads } from './downloads.ts';
import type { BrowserWindow } from './window.ts';

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export interface Services {
  settings: SettingsStore;
  bookmarks: UrlStore;
  history: UrlStore;
  downloads: Downloads;
  newWindow(options?: { isPrivate?: boolean }): void;
  layoutIds(): string[];
  keymapIds(): string[];
  clearData(w: BrowserWindow): Promise<void>;
  pageInfo(w: BrowserWindow): Promise<void>;
}

/** Downloads may only be started for web addresses: never local files or internal pages. */
function downloadable(url: unknown): string {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || !URL.canParse(url)) throw new Error('only web addresses can be saved');
  return url;
}

/** Handlers for the shell commands. Each receives the window it was invoked in. */
export function registerHandlers(registry: CommandRegistry<BrowserWindow>, s: Services): void {
  const on = registry.register.bind(registry);
  /** The view that has focus in this window: the UI or the active tab. */
  const focused = (w: BrowserWindow) => {
    const f = webContents.getFocusedWebContents();
    return f === w.ui.webContents ? f : w.activeContents;
  };
  const zoom = (w: BrowserWindow, direction: 1 | -1) => {
    const wc = w.activeContents;
    if (!wc) return;
    const now = wc.getZoomFactor();
    const next = direction > 0 ? ZOOM_STEPS.find((z) => z > now + 0.001) : ZOOM_STEPS.findLast((z) => z < now - 0.001);
    if (next !== undefined) wc.setZoomFactor(next);
  };
  const remember = (w: BrowserWindow, patch: Parameters<SettingsStore['update']>[0]) => {
    // Private windows never write to the profile.
    if (!w.isPrivate) s.settings.update(patch);
  };

  // ---- app ----
  on('app.new-window', () => s.newWindow());
  on('app.new-private-window', () => s.newWindow({ isPrivate: true }));
  on('app.quit', () => app.quit());
  on('app.command-palette', (w) => w.toggleOverlay('palette'));

  // ---- file ----
  on('file.open-location', (w) => w.focusAddressBar());
  on('file.open-file', async (w) => {
    const { filePaths } = await dialog.showOpenDialog(w.win, { properties: ['openFile'] });
    // The user picked this file in a system dialog: that is the authorization.
    if (filePaths[0]) w.navigate(pathToFileURL(filePaths[0]).href, 'user-command');
  });
  on('file.save-page-as', async (w) => {
    const wc = w.activeContents;
    if (!wc) return;
    // Only real documents can be saved; a blank or failed tab would never finish saving.
    if (!/^(https?|file|gopher):/.test(wc.getURL()) || wc.isCrashed()) throw new Error('this page cannot be saved');
    const { canceled, filePath } = await dialog.showSaveDialog(w.win, {
      defaultPath: `${sanitizeFilename(wc.getTitle() || 'page', 'page')}.html`,
      filters: [
        { name: 'Web page, complete', extensions: ['html', 'htm'] },
        { name: 'Web archive, single file', extensions: ['mhtml'] },
      ],
    });
    if (canceled || !filePath) return;
    await wc.savePage(filePath, /\.mhtml$/i.test(filePath) ? 'MHTML' : 'HTMLComplete');
    w.showNotice(`Saved ${sanitizeFilename(filePath)}.`);
  });
  on('file.save-link', (w, { url }) => w.activeContents?.downloadURL(downloadable(url)));
  on('file.save-image', (w, { url }) => w.activeContents?.downloadURL(downloadable(url)));
  on('file.print', (w) => w.activeContents?.print());

  // ---- edit ----
  on('edit.undo', (w) => focused(w)?.undo());
  on('edit.redo', (w) => focused(w)?.redo());
  on('edit.cut', (w) => focused(w)?.cut());
  on('edit.copy', (w) => focused(w)?.copy());
  on('edit.paste', (w) => focused(w)?.paste());
  on('edit.select-all', (w) => focused(w)?.selectAll());
  on('edit.find', (w) => w.openFind());
  on('edit.find-next', (w, { text }) => w.find(typeof text === 'string' ? text : undefined, true));
  on('edit.find-previous', (w, { text }) => w.find(typeof text === 'string' ? text : undefined, false));
  on('edit.find-close', (w) => w.closeFind());
  on('edit.copy-link', (_w, { url }) => clipboard.writeText(String(url)));
  on('edit.copy-image', (w, { x, y }) => w.activeContents?.copyImageAt(Math.round(Number(x)), Math.round(Number(y))));
  on('edit.replace-misspelling', (w, { text }) => { if (text) focused(w)?.replaceMisspelling(String(text)); });

  // ---- view ----
  on('view.zoom-in', (w) => zoom(w, 1));
  on('view.zoom-out', (w) => zoom(w, -1));
  on('view.zoom-reset', (w) => w.activeContents?.setZoomFactor(1));
  on('view.full-screen', (w) => w.win.setFullScreen(!w.win.isFullScreen()));
  on('view.page-source', (w) => {
    const url = w.activeContents?.getURL();
    if (url) w.newTab(`view-source:${url}`, 'user-command');
  });
  on('view.menu-layout', (w, { layout }) => {
    if (!s.layoutIds().includes(String(layout))) throw new Error(`unknown layout ${String(layout)}`);
    w.setLayout(String(layout));
    remember(w, { layout: String(layout) });
  });
  on('view.keymap', (w, { keymap }) => {
    if (!s.keymapIds().includes(String(keymap))) throw new Error(`unknown keymap ${String(keymap)}`);
    w.setKeymap(String(keymap));
    remember(w, { keymap: String(keymap) });
  });

  // ---- nav ----
  on('nav.back', (w) => w.activeContents?.navigationHistory.goBack());
  on('nav.forward', (w) => w.activeContents?.navigationHistory.goForward());
  on('nav.reload', (w) => w.activeContents?.reload());
  on('nav.reload-hard', (w) => w.activeContents?.reloadIgnoringCache());
  on('nav.stop', (w) => w.activeContents?.stop());
  on('nav.home', (w) => w.navigate(s.settings.get().homePage, 'internal'));
  on('nav.go', (w, { text }) => w.go(String(text)));
  on('nav.set-home-page', (w) => {
    const url = displayUrl(w.activeContents?.getURL() ?? '');
    if (!isValidHomePage(url)) throw new Error('this page cannot be a home page');
    if (w.isPrivate) return w.showNotice('Settings cannot be changed from a private window.');
    s.settings.update({ homePage: url });
    w.showNotice('Home page set to this page.');
  });

  // ---- tab ----
  on('tab.new', (w) => { w.newTab(); w.focusAddressBar(); });
  on('tab.close', (w, { index }) => (typeof index === 'number' ? w.closeTab(Math.trunc(index) - 1) : w.closeTab()));
  on('tab.next', (w) => w.cycle(1));
  on('tab.previous', (w) => w.cycle(-1));
  on('tab.select', (w, { index }) => w.selectIndex(Math.trunc(Number(index)) - 1));
  on('tab.duplicate', (w) => {
    const url = w.activeContents?.getURL();
    if (url) w.newTab(url, 'user-command');
  });
  on('tab.reopen-closed', (w) => w.reopenClosed());
  // Link and image addresses come from the page, so they are opened with the page's (lower) authority.
  on('tab.open-link', (w, { url }) => w.newTab(String(url), 'web-content', w.activeContents?.getURL()));
  on('tab.open-image', (w, { url }) => w.newTab(String(url), 'web-content', w.activeContents?.getURL()));

  // ---- bookmarks ----
  on('bookmark.toggle', (w) => {
    const wc = w.activeContents;
    if (!wc) return;
    const url = wc.getURL();
    if (s.bookmarks.removeUrl(url)) return w.showNotice('Bookmark removed.');
    if (!s.bookmarks.add(url, wc.getTitle(), Date.now())) throw new Error('this page cannot be bookmarked');
    w.showNotice('Page bookmarked.');
  });
  on('bookmark.show', (w) => w.toggleOverlay('bookmarks'));
  on('bookmark.open', (w, { id }) => {
    const entry = s.bookmarks.get(Number(id));
    if (!entry) throw new Error('no such bookmark');
    w.setOverlay(undefined);
    w.navigate(entry.url, 'user-command');
  });
  on('bookmark.remove', (_w, { id }) => { s.bookmarks.remove(Number(id)); });

  // ---- history ----
  on('history.show', (w) => w.toggleOverlay('history'));
  on('history.open', (w, { id }) => {
    const entry = s.history.get(Number(id));
    if (!entry) throw new Error('no such history entry');
    w.setOverlay(undefined);
    w.navigate(entry.url, 'user-command');
  });
  on('history.remove', (_w, { id }) => { s.history.remove(Number(id)); });

  // ---- page ----
  on('page.info', (w) => s.pageInfo(w));
  on('page.search-selection', (w, { text }) => {
    const query = String(text).trim();
    if (query) w.newTab(searchUrl(s.settings.get().searchTemplate, query), 'user-command');
  });

  // ---- tools ----
  on('tools.dev-tools', (w) => w.activeContents?.openDevTools({ mode: 'detach' }));
  on('tools.inspect-element', (w, { x, y }) => w.activeContents?.inspectElement(Math.round(Number(x)), Math.round(Number(y))));
  on('tools.downloads', (w) => w.toggleOverlay('downloads'));
  on('tools.download-open', (w, { id }) => s.downloads.open(Number(id), w.win));
  on('tools.download-show', (_w, { id }) => s.downloads.show(Number(id)));
  on('tools.download-dismiss', (_w, { id }) => s.downloads.dismiss(Number(id)));
  on('tools.downloads-clear', () => s.downloads.clearFinished());
  on('tools.search-engine', (w, { engine }) => {
    const choice = Object.hasOwn(SEARCH_ENGINES, String(engine)) ? SEARCH_ENGINES[String(engine)] : undefined;
    if (!choice) throw new Error(`unknown search engine ${String(engine)}`);
    if (w.isPrivate) return w.showNotice('Settings cannot be changed from a private window.');
    s.settings.update({ searchTemplate: choice.template });
    w.showNotice(`Searches now use ${choice.label}.`);
  });
  on('input.modal-mode', (w) => w.setModal(!w.modal));

  // ---- privacy ----
  on('privacy.clear-data', (w) => s.clearData(w));

  // ---- help ----
  on('help.menu-archaeology', (w) => w.newTab(`${PAGES_ORIGIN}/archaeology`, 'internal'));
  on('help.about', (w) => w.newTab(`${PAGES_ORIGIN}/about`, 'internal'));

  // ---- legacy ----
  on('legacy.flash', (w) => w.enableFlash());
  on('legacy.gopher-open', (w, { url }) => {
    if (typeof url === 'string') {
      if (!/^gopher:\/\//i.test(url)) throw new Error('not a gopher URL');
      w.navigate(url, 'user-command');
    } else {
      w.newTab('gopher://gopher.floodgap.com/', 'user-command');
    }
  });
}
