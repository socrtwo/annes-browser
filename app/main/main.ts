import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, ipcMain, Menu } from 'electron';
import type { Catalog } from '../core/catalog/types.ts';
import { IPC, parseExecuteRequest, parsePaletteQuery } from '../core/ipc.ts';
import { buildMenu, everythingLayout, type MenuNode } from '../core/menu/build.ts';
import { PaletteIndex } from '../core/palette/search.ts';
import { CommandRegistry, type ExecuteResult, type InvocationSource } from '../core/registry.ts';
import { PAGES_ORIGIN } from '../core/security/url-policy.ts';
import { registerHandlers } from './commands.ts';
import { toElectronMenu } from './menu.ts';
import { registerSchemes, serveUi, serveWeb } from './protocols.ts';
import { hardenUiSession, hardenWebSession, hasUnsafeSwitches, installGlobalGuards, sessions } from './security.ts';
import { BrowserWindow } from './window.ts';

const dist = join(__dirname, '..');
const os = process.platform === 'darwin' ? 'mac' : 'other';

const unsafe = app.isPackaged ? hasUnsafeSwitches(process.argv) : undefined;
if (unsafe) {
  console.error(`Refusing to start with ${unsafe.split('=')[0]}.`);
  app.exit(2);
}

// Every renderer is sandboxed, including any created by mistake without explicit settings.
// The one exception is a development run started with --no-sandbox, which Chromium requires
// when running as root (CI containers). Packaged builds refuse that flag above.
if (!process.argv.includes('--no-sandbox')) app.enableSandbox();
registerSchemes();
installGlobalGuards();

const catalog = JSON.parse(readFileSync(join(dist, 'catalog.json'), 'utf8')) as Catalog;
const windows = new Set<BrowserWindow>();
const menuCache = new WeakMap<BrowserWindow, string>();
const pending = new Set<BrowserWindow>();

const registry = new CommandRegistry<BrowserWindow>(catalog, {
  platform: 'desktop',
  getContext: (w) => w.context(),
  onStub: (record, w) => w.newTab(`${PAGES_ORIGIN}/stub?id=${encodeURIComponent(record.id)}`, 'internal'),
  onUnimplemented: (record, w) => w.showNotice(`${record.label} is not built yet (planned for phase ${record.phase}).`),
  onError: (record, error) => console.error(`command ${record.id} failed:`, error),
});

const layouts = [...catalog.layouts, everythingLayout(registry.visible())];
const palette = new PaletteIndex(registry.visible());

async function execute(w: BrowserWindow, id: string, source: InvocationSource, args?: Record<string, unknown>): Promise<ExecuteResult> {
  const result = await registry.execute(id, { source, host: w, ...(args && { args }) });
  // Keys that do nothing right now stay quiet; deliberate choices get an explanation.
  if (!result.ok && source !== 'key' && ['disabled', 'forbidden', 'invalid-args', 'failed'].includes(result.reason)) {
    w.showNotice(result.message);
  }
  refresh(w);
  return result;
}

function menuFor(w: BrowserWindow): MenuNode[] {
  const visible = new Map(registry.visible().map((c) => [c.id, c]));
  const layout = layouts.find((l) => l.id === w.layout) ?? layouts[0]!;
  const ctx = w.context();
  const nodes = buildMenu(layout, {
    command: (id) => visible.get(id),
    isEnabled: (id, c) => registry.isEnabled(id, c),
    isChecked: (id, c) => registry.isChecked(id, c),
    keysFor: (id) => w.keysFor(id),
  }, ctx);
  // Layout and keyboard-profile switching is offered in every layout.
  nodes.push({
    type: 'submenu',
    label: 'Layout',
    items: [
      ...layouts.map((l): MenuNode => ({ type: 'command', id: `view.menu-layout:${l.id}`, label: l.label, enabled: true, checked: l.id === w.layout, stub: false })),
      { type: 'separator' },
      ...catalog.keymaps.map((k): MenuNode => ({ type: 'command', id: `view.keymap:${k.id}`, label: `Keys: ${k.label}`, enabled: true, checked: k.id === w.keymap, stub: false })),
    ],
  });
  return nodes;
}

function applyMenu(w: BrowserWindow): void {
  const nodes = menuFor(w);
  const key = JSON.stringify(nodes);
  if (menuCache.get(w) === key) return;
  menuCache.set(w, key);
  const menu = toElectronMenu(nodes, os, (id) => {
    const [command, value] = id.split(':') as [string, string | undefined];
    const args = value === undefined ? undefined : command === 'view.menu-layout' ? { layout: value } : { keymap: value };
    void execute(w, command, 'menu', args);
  });
  if (os === 'mac') Menu.setApplicationMenu(menu);
  else w.win.setMenu(menu);
}

/** Coalesce bursts of state changes into one menu rebuild and one UI update. */
function refresh(w: BrowserWindow): void {
  if (pending.has(w)) return;
  pending.add(w);
  setTimeout(() => {
    pending.delete(w);
    if (!windows.has(w) || w.win.isDestroyed()) return;
    applyMenu(w);
    w.sendState();
  }, 30);
}

function newWindow(url?: string): BrowserWindow {
  const w = new BrowserWindow({
    catalog,
    os,
    preload: join(dist, 'preload', 'chrome.cjs'),
    execute: (win, id, source, args) => void execute(win, id, source, args),
    changed: refresh,
    closed: (win) => windows.delete(win),
  });
  windows.add(w);
  if (url) w.newTab(url, 'user-command');
  else w.newTab();
  refresh(w);
  return w;
}

/** Find the window whose UI sent an IPC message; anything else is ignored. */
function senderWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | undefined {
  const frame = event.senderFrame;
  if (!frame) return undefined;
  const isMain = frame === event.sender.mainFrame;
  return [...windows].find((w) => w.isUiSender(event.sender, frame.url, isMain));
}

function installIpc(): void {
  ipcMain.handle(IPC.execute, async (event, raw: unknown) => {
    const w = senderWindow(event);
    const req = parseExecuteRequest(raw);
    if (!w || !req) return { ok: false, reason: 'invalid-args', message: 'rejected' } satisfies ExecuteResult;
    if (req.source === 'palette') w.setPalette(false);
    return execute(w, req.id, req.source, req.args);
  });
  ipcMain.handle(IPC.paletteSearch, (event, raw: unknown) => {
    const query = parsePaletteQuery(raw);
    if (!senderWindow(event) || query === undefined) return [];
    return palette.search(query, 30);
  });
  ipcMain.on(IPC.ready, (event) => senderWindow(event)?.sendState());
  ipcMain.on(IPC.paletteClose, (event) => senderWindow(event)?.setPalette(false));
}

/** URLs handed over by the operating system (default-browser launches, second instances). */
function urlsFromArgv(argv: readonly string[]): string[] {
  return argv.slice(1).filter((a) => /^(https?|file|gopher):\/\//i.test(a));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const w = [...windows][0];
    const urls = urlsFromArgv(argv);
    if (!w) { newWindow(urls[0]); return; }
    for (const url of urls) w.newTab(url, 'user-command');
    w.win.focus();
  });
  app.on('window-all-closed', () => { if (os !== 'mac') app.quit(); });
  app.on('activate', () => { if (windows.size === 0) newWindow(); });

  void app.whenReady().then(() => {
    const { ui, web } = sessions();
    hardenUiSession(ui);
    hardenWebSession(web);
    serveUi(ui, join(dist, 'ui'));
    serveWeb(web, { visibleCommands: () => registry.visible(), command: (id) => registry.get(id) });
    registerHandlers(registry, {
      newWindow: () => void newWindow(),
      layoutIds: () => layouts.map((l) => l.id),
      keymapIds: () => catalog.keymaps.map((k) => k.id),
    });
    installIpc();
    newWindow(urlsFromArgv(process.argv)[0]);
  });
}
