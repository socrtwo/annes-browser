import { app, dialog, webContents } from 'electron';
import { pathToFileURL } from 'node:url';
import type { CommandRegistry } from '../core/registry.ts';
import { PAGES_ORIGIN } from '../core/security/url-policy.ts';
import type { BrowserWindow } from './window.ts';
import { HOME_URL } from './window.ts';

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export interface AppActions {
  newWindow(): void;
  layoutIds(): string[];
  keymapIds(): string[];
}

/** Handlers for the Phase 2 shell commands. Each receives the window it was invoked in. */
export function registerHandlers(registry: CommandRegistry<BrowserWindow>, actions: AppActions): void {
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

  on('app.new-window', () => actions.newWindow());
  on('app.quit', () => app.quit());
  on('app.command-palette', (w) => w.setPalette(!w.paletteOpen));

  on('file.open-location', (w) => w.focusAddressBar());
  on('file.open-file', async (w) => {
    const { filePaths } = await dialog.showOpenDialog(w.win, { properties: ['openFile'] });
    // The user picked this file in a system dialog: that is the authorization.
    if (filePaths[0]) w.navigate(pathToFileURL(filePaths[0]).href, 'user-command');
  });
  on('file.print', (w) => w.activeContents?.print());

  on('edit.undo', (w) => focused(w)?.undo());
  on('edit.redo', (w) => focused(w)?.redo());
  on('edit.cut', (w) => focused(w)?.cut());
  on('edit.copy', (w) => focused(w)?.copy());
  on('edit.paste', (w) => focused(w)?.paste());
  on('edit.select-all', (w) => focused(w)?.selectAll());

  on('view.zoom-in', (w) => zoom(w, 1));
  on('view.zoom-out', (w) => zoom(w, -1));
  on('view.zoom-reset', (w) => w.activeContents?.setZoomFactor(1));
  on('view.full-screen', (w) => w.win.setFullScreen(!w.win.isFullScreen()));
  on('view.page-source', (w) => {
    const url = w.activeContents?.getURL();
    if (url) w.newTab(`view-source:${url}`, 'user-command');
  });
  on('view.menu-layout', (w, { layout }) => {
    if (!actions.layoutIds().includes(String(layout))) throw new Error(`unknown layout ${String(layout)}`);
    w.setLayout(String(layout));
  });
  on('view.keymap', (w, { keymap }) => {
    if (!actions.keymapIds().includes(String(keymap))) throw new Error(`unknown keymap ${String(keymap)}`);
    w.setKeymap(String(keymap));
  });

  on('nav.back', (w) => w.activeContents?.navigationHistory.goBack());
  on('nav.forward', (w) => w.activeContents?.navigationHistory.goForward());
  on('nav.reload', (w) => w.activeContents?.reload());
  on('nav.reload-hard', (w) => w.activeContents?.reloadIgnoringCache());
  on('nav.stop', (w) => w.activeContents?.stop());
  on('nav.home', (w) => w.navigate(HOME_URL, 'internal'));
  on('nav.go', (w, { text }) => w.go(String(text)));

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

  on('tools.dev-tools', (w) => w.activeContents?.openDevTools({ mode: 'detach' }));
  on('input.modal-mode', (w) => w.setModal(!w.modal));

  on('help.menu-archaeology', (w) => w.newTab(`${PAGES_ORIGIN}/archaeology`, 'internal'));
  on('help.about', (w) => w.newTab(`${PAGES_ORIGIN}/about`, 'internal'));

  on('legacy.gopher-open', (w, { url }) => {
    if (typeof url === 'string') {
      if (!/^gopher:\/\//i.test(url)) throw new Error('not a gopher URL');
      w.navigate(url, 'user-command');
    } else {
      w.newTab('gopher://gopher.floodgap.com/', 'user-command');
    }
  });
}
