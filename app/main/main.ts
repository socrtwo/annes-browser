import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog, ipcMain, Menu, session, type WebContents } from 'electron';
import type { Catalog } from '../core/catalog/types.ts';
import { SEARCH_ENGINES, SettingsStore } from '../core/data/settings.ts';
import { UrlStore } from '../core/data/url-store.ts';
import { IPC, type ListItem, parseExecuteRequest, parseListRequest, parsePaletteQuery } from '../core/ipc.ts';
import { buildMenu, everythingLayout, type MenuNode } from '../core/menu/build.ts';
import { contextMenuItems, type ContextTarget } from '../core/menu/context.ts';
import { PaletteIndex } from '../core/palette/search.ts';
import { CommandRegistry, type ExecuteResult, type InvocationSource } from '../core/registry.ts';
import { PermissionPolicy, permissionLabel } from '../core/security/permissions.ts';
import { hasUnsafeSwitches } from '../core/security/startup.ts';
import { displayUrl, PAGES_ORIGIN } from '../core/security/url-policy.ts';
import { registerHandlers } from './commands.ts';
import { Downloads } from './downloads.ts';
import { toElectronMenu } from './menu.ts';
import { registerSchemes, serveRuffle, serveUi, serveWeb } from './protocols.ts';
import {
  certificateFor, hardenUiSession, hardenWebSession, installGlobalGuards, newPrivatePartition, UI_PARTITION, WEB_PARTITION,
} from './security.ts';
import { BrowserWindow } from './window.ts';

const dist = join(__dirname, '..');
const os = process.platform === 'darwin' ? 'mac' : 'other';
const dev = !app.isPackaged;

const unsafe = app.isPackaged ? hasUnsafeSwitches(process.argv) : undefined;
if (unsafe) {
  console.error(`Refusing to start with ${unsafe.split('=')[0]}.`);
  app.exit(2);
}

// Development builds may keep their profile elsewhere, so tests never touch a real one.
if (dev && process.env['ANNE_DEV_USER_DATA']) app.setPath('userData', process.env['ANNE_DEV_USER_DATA']);

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
let listVersion = 0;

const registry = new CommandRegistry<BrowserWindow>(catalog, {
  platform: 'desktop',
  getContext: (w) => w.context(),
  onStub: (record, w) => w.newTab(`${PAGES_ORIGIN}/stub?id=${encodeURIComponent(record.id)}`, 'internal'),
  onUnimplemented: (record, w) => w.showNotice(`${record.label} is not built yet (planned for phase ${record.phase}).`),
  onError: (record, error) => console.error(`command ${record.id} failed:`, error),
});

const layouts = [...catalog.layouts, everythingLayout(registry.visible())];
// The palette lists only commands that can run without arguments.
const palette = new PaletteIndex(registry.visible().filter((c) => (c.args ?? []).every((a) => a.optional)));

// ---- profile data (created once the app is ready and the user-data path is final) ----
let settings!: SettingsStore;
let bookmarks!: UrlStore;
let history!: UrlStore;
let downloads!: Downloads;

function windowFor(wc: WebContents): BrowserWindow | undefined {
  return [...windows].find((w) => w.owns(wc));
}

function dataChanged(): void {
  listVersion++;
  for (const w of windows) refresh(w);
}

// ---- web sessions: one persistent, plus one in-memory session per private window ----
const policies = new Map<string, PermissionPolicy<WebContents>>();

function prepareWebSession(partition: string): void {
  if (policies.has(partition)) return;
  const ses = session.fromPartition(partition);
  const policy = new PermissionPolicy<WebContents>(async (origin, permission, wc) => {
    const w = windowFor(wc);
    return w ? w.askPermission(origin, permission) : false;
  });
  policies.set(partition, policy);
  hardenWebSession(ses, policy);
  serveWeb(ses, { visibleCommands: () => registry.visible(), command: (id) => registry.get(id) });
  serveRuffle(ses, join(dist, 'ruffle'));
  downloads.attach(ses, partition);
}

// ---- commands ----

async function execute(w: BrowserWindow, id: string, source: InvocationSource, args?: Record<string, unknown>): Promise<ExecuteResult> {
  const result = await registry.execute(id, { source, host: w, ...(args && { args }) });
  // Keys that do nothing right now stay quiet; deliberate choices get an explanation.
  if (!result.ok && source !== 'key' && ['disabled', 'forbidden', 'invalid-args', 'failed'].includes(result.reason)) {
    w.showNotice(result.message);
  }
  refresh(w);
  return result;
}

function bookmarkEntries(): MenuNode[] {
  return bookmarks.search('', 30).map((b): MenuNode => ({
    type: 'command', id: 'bookmark.open', args: { id: b.id }, enabled: true, stub: false,
    label: b.title.length > 60 ? `${b.title.slice(0, 57)}...` : b.title,
  }));
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
  // Classic browsers list bookmarks in the menu itself, under the commands.
  const entries = bookmarkEntries();
  for (const top of nodes) {
    if (top.type === 'submenu' && entries.length > 0 && top.items.some((i) => i.type === 'command' && i.id === 'bookmark.show')) {
      top.items.push({ type: 'separator' }, ...entries);
    }
  }
  const template = settings.get().searchTemplate;
  // Layout, keyboard profile and search engine are offered in every layout.
  nodes.push({
    type: 'submenu',
    label: 'Layout',
    items: [
      ...layouts.map((l): MenuNode => ({ type: 'command', id: 'view.menu-layout', args: { layout: l.id }, label: l.label, enabled: true, checked: l.id === w.layout, stub: false })),
      { type: 'separator' },
      ...catalog.keymaps.map((k): MenuNode => ({ type: 'command', id: 'view.keymap', args: { keymap: k.id }, label: `Keys: ${k.label}`, enabled: true, checked: k.id === w.keymap, stub: false })),
      { type: 'separator' },
      {
        type: 'submenu',
        label: 'Search Engine',
        items: Object.entries(SEARCH_ENGINES).map(([id, e]): MenuNode => ({
          type: 'command', id: 'tools.search-engine', args: { engine: id }, label: e.label, enabled: !w.isPrivate, checked: e.template === template, stub: false,
        })),
      },
    ],
  });
  return nodes;
}

function applyMenu(w: BrowserWindow): void {
  const nodes = menuFor(w);
  const key = JSON.stringify(nodes);
  if (menuCache.get(w) === key) return;
  menuCache.set(w, key);
  const menu = toElectronMenu(nodes, os, (id, args) => void execute(w, id, 'menu', args));
  if (os === 'mac') Menu.setApplicationMenu(menu);
  else w.win.setMenu(menu);
}

function showContextMenu(w: BrowserWindow, target: ContextTarget): void {
  const ctx = w.context();
  const nodes = contextMenuItems(target).flatMap((item): MenuNode[] => {
    if ('separator' in item) return [{ type: 'separator' }];
    const record = registry.get(item.id);
    if (!record || record.status === 'omit') return [];
    const checked = registry.isChecked(item.id, ctx);
    return [{
      type: 'command', id: item.id, label: item.label ?? record.label, stub: false,
      enabled: item.enabled ?? registry.isEnabled(item.id, ctx),
      ...(item.args && { args: item.args }),
      ...(checked !== undefined && { checked }),
    }];
  });
  if (nodes.length === 0) return;
  toElectronMenu(nodes, os, (id, args) => void execute(w, id, 'menu', args)).popup({ window: w.win as Electron.BrowserWindow });
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

function newWindow(options: { url?: string; isPrivate?: boolean } = {}): BrowserWindow {
  const isPrivate = options.isPrivate === true;
  const partition = isPrivate ? newPrivatePartition() : WEB_PARTITION;
  prepareWebSession(partition);
  const w = new BrowserWindow({
    catalog, os, settings, bookmarks, history,
    preload: join(dist, 'preload', 'chrome.cjs'),
    listVersion: () => listVersion,
    downloadCount: () => downloads.count,
    execute: (win, id, source, args) => void execute(win, id, source, args),
    contextMenu: showContextMenu,
    changed: refresh,
    closed: (win) => {
      windows.delete(win);
      if (win.isPrivate) void forgetPrivateSession(win.partition);
    },
  }, { partition, isPrivate });
  windows.add(w);
  if (options.url) w.newTab(options.url, 'user-command');
  else w.newTab();
  refresh(w);
  return w;
}

/** A private window closed: erase everything its session held. */
async function forgetPrivateSession(partition: string): Promise<void> {
  downloads.forgetPartition(partition);
  policies.get(partition)?.forget();
  const ses = session.fromPartition(partition);
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache();
}

// ---- Page Info and Clear Browsing Data ----

async function pageInfo(w: BrowserWindow): Promise<void> {
  const wc = w.activeContents;
  if (!wc) return;
  const url = wc.getURL();
  let u: URL | undefined;
  try { u = new URL(url); } catch { /* blank tab */ }
  const lines = [`Address: ${displayUrl(url).slice(0, 500)}`];
  const scheme = u?.protocol ?? '';
  if (scheme === 'https:') {
    const cert = certificateFor(u!.hostname);
    lines.push('Connection: encrypted (HTTPS).');
    if (cert) {
      const day = (t: number) => new Date(t).toISOString().slice(0, 10);
      lines.push(
        `Certificate issued to: ${cert.subject}`,
        `Issued by: ${cert.issuer}`,
        `Valid: ${day(cert.validFrom)} to ${day(cert.validTo)}`,
        `Fingerprint: ${cert.fingerprint}`,
        `Verification: ${cert.verification === 'net::OK' ? 'passed' : cert.verification}`,
      );
    }
  } else if (scheme === 'http:') {
    lines.push('Connection: NOT encrypted (HTTP). Anyone on the network path can read or change this page.');
  } else if (scheme === 'gopher:') {
    lines.push('Connection: not encrypted (Gopher).');
  } else if (scheme === 'file:') {
    lines.push('This is a file on your computer.');
  } else if (scheme === 'anne:') {
    lines.push("This is a page built into Anne's Browser.");
  }
  if (u && /^https?:$/.test(scheme)) {
    const granted = policies.get(w.partition)?.granted(u.origin) ?? [];
    lines.push(`Permissions allowed this session: ${granted.length ? granted.map(permissionLabel).join('; ') : 'none'}`);
    const cookies = await session.fromPartition(w.partition).cookies.get({ url });
    lines.push(`Cookies this page can read: ${cookies.length}`);
  }
  if (w.win.isDestroyed()) return;
  await dialog.showMessageBox(w.win, {
    type: 'info', title: 'Page Info', buttons: ['OK'], noLink: true,
    message: (wc.getTitle() || displayUrl(url)).slice(0, 200),
    detail: lines.join('\n'),
  });
}

async function clearData(w: BrowserWindow): Promise<void> {
  const { response } = await dialog.showMessageBox(w.win, {
    type: 'warning',
    title: 'Clear Browsing Data',
    buttons: ['Cancel', 'History Only', 'Everything'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: 'Clear browsing data?',
    detail: [
      'History Only: the list of pages you visited, and recently closed tabs.',
      'Everything: also cookies (you will be signed out of sites), cached files, site storage, site permissions and the download list.',
      'Bookmarks, settings and downloaded files are kept.',
      w.isPrivate ? 'This clears your normal browsing data. This private window is erased when it closes.' : '',
    ].filter(Boolean).join('\n\n'),
  });
  if (response === 0) return;
  history.clear();
  history.flush();
  for (const win of windows) win.clearClosedTabs();
  if (response === 2) {
    const ses = session.fromPartition(WEB_PARTITION);
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
    await ses.clearHostResolverCache();
    policies.get(WEB_PARTITION)?.forget();
    downloads.clearFinished();
  }
  if (!w.win.isDestroyed()) w.showNotice(response === 2 ? 'Browsing data cleared.' : 'History cleared.');
}

// ---- IPC from the browser UI ----

/** Find the window whose UI sent an IPC message; anything else is ignored. */
function senderWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | undefined {
  const frame = event.senderFrame;
  if (!frame) return undefined;
  const isMain = frame === event.sender.mainFrame;
  return [...windows].find((w) => w.isUiSender(event.sender, frame.url, isMain));
}

function listItems(kind: 'bookmarks' | 'history' | 'downloads', query: string): ListItem[] {
  if (kind === 'downloads') return downloads.list(query);
  const store = kind === 'bookmarks' ? bookmarks : history;
  const when = (t: number) => new Date(t).toLocaleString();
  return store.search(query, 500).map((e): ListItem => ({
    id: e.id,
    title: e.title,
    url: displayUrl(e.url).slice(0, 500),
    detail: kind === 'bookmarks' ? `Added ${when(e.time)}` : `${when(e.time)}${e.count > 1 ? ` · ${e.count} visits` : ''}`,
    open: kind === 'bookmarks' ? 'bookmark.open' : 'history.open',
    remove: kind === 'bookmarks' ? 'bookmark.remove' : 'history.remove',
  }));
}

function installIpc(): void {
  ipcMain.handle(IPC.execute, async (event, raw: unknown) => {
    const w = senderWindow(event);
    const req = parseExecuteRequest(raw);
    if (!w || !req) return { ok: false, reason: 'invalid-args', message: 'rejected' } satisfies ExecuteResult;
    if (req.source === 'palette') w.setOverlay(undefined);
    return execute(w, req.id, req.source, req.args);
  });
  ipcMain.handle(IPC.paletteSearch, (event, raw: unknown) => {
    const query = parsePaletteQuery(raw);
    if (!senderWindow(event) || query === undefined) return [];
    return palette.search(query, 30);
  });
  ipcMain.handle(IPC.list, (event, raw: unknown) => {
    const req = parseListRequest(raw);
    const w = senderWindow(event);
    // A panel can only be read while it is open.
    if (!w || !req || w.overlay !== req.kind) return [];
    return listItems(req.kind, req.query);
  });
  ipcMain.on(IPC.ready, (event) => senderWindow(event)?.sendState());
  ipcMain.on(IPC.closeOverlay, (event) => senderWindow(event)?.setOverlay(undefined));
}

/** URLs handed over by the operating system (default-browser launches, second instances). */
function urlsFromArgv(argv: readonly string[]): string[] {
  return argv.slice(1).filter((a) => /^(https?|file|gopher):\/\//i.test(a));
}

function reportLoadProblems(problems: string[]): void {
  for (const p of problems) console.warn(`profile: ${p}`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const w = [...windows].find((x) => !x.isPrivate);
    const urls = urlsFromArgv(argv);
    if (!w) { newWindow(urls[0] ? { url: urls[0] } : {}); return; }
    for (const url of urls) w.newTab(url, 'user-command');
    w.win.focus();
  });
  app.on('window-all-closed', () => { if (os !== 'mac') app.quit(); });
  app.on('activate', () => { if (windows.size === 0) newWindow(); });
  app.on('before-quit', () => {
    history?.flush();
    bookmarks?.flush();
  });

  void app.whenReady().then(() => {
    const profile = join(app.getPath('userData'), 'profile');
    settings = new SettingsStore(join(profile, 'settings.json'), {
      layouts: layouts.map((l) => l.id),
      keymaps: catalog.keymaps.map((k) => k.id),
    });
    bookmarks = new UrlStore({ cap: 10_000, path: join(profile, 'bookmarks.json'), writeDelayMs: 200 });
    history = new UrlStore({ cap: 5_000, path: join(profile, 'history.json') });
    reportLoadProblems([...settings.loadProblems, ...bookmarks.loadProblems, ...history.loadProblems]);
    bookmarks.onDidChange(dataChanged);
    history.onDidChange(dataChanged);
    settings.onDidChange(() => { for (const w of windows) refresh(w); });
    downloads = new Downloads(
      { windowFor: (wc) => windowFor(wc)?.win, changed: dataChanged },
      dev ? process.env['ANNE_DEV_DOWNLOAD_DIR'] || undefined : undefined,
    );

    hardenUiSession(session.fromPartition(UI_PARTITION));
    serveUi(session.fromPartition(UI_PARTITION), join(dist, 'ui'));
    registerHandlers(registry, {
      settings, bookmarks, history, downloads,
      newWindow: (o) => void newWindow(o ?? {}),
      layoutIds: () => layouts.map((l) => l.id),
      keymapIds: () => catalog.keymaps.map((k) => k.id),
      clearData,
      pageInfo,
    });
    installIpc();
    const first = urlsFromArgv(process.argv)[0];
    newWindow(first ? { url: first } : {});
  });
}
