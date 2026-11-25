import { app, type Session, session, type WebContents } from 'electron';
import { sanitizeFilename } from '../core/security/downloads.ts';
import { PermissionPolicy } from '../core/security/permissions.ts';
import { CHROME_ORIGIN, INTERNAL_SCHEME } from '../core/security/url-policy.ts';

/**
 * Two sessions, never mixed:
 *  - the UI session holds only the browser's own interface and has no network access;
 *  - the web session holds everything the user browses.
 * They have separate storage, separate protocol handlers and separate rules.
 */
export const UI_PARTITION = 'anne-ui';
export const WEB_PARTITION = 'persist:web';

/** Renderer settings for web content. Nothing here may be loosened per tab. */
export const WEB_PREFERENCES = {
  partition: WEB_PARTITION,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  safeDialogs: true,
  spellcheck: true,
} as const;

/** Renderer settings for the browser UI: sandboxed, with only the preload bridge. */
export function uiPreferences(preload: string) {
  return {
    partition: UI_PARTITION,
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    devTools: !app.isPackaged,
  } as const;
}

export const permissions = new PermissionPolicy();

function originOf(url: string | undefined): string | undefined {
  try { return url ? new URL(url).origin : undefined; } catch { return undefined; }
}

export function hardenWebSession(ses: Session): void {
  // Present as the underlying engine. Naming the app adds a fingerprint and breaks user-agent checks.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|annes-browser)\/\S+/gi, ''));

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    // Only the top-level page's own origin may ask; embedded third-party frames may not.
    const origin = details.isMainFrame === false ? undefined : originOf(details.requestingUrl ?? wc?.getURL());
    if (!origin) return callback(false);
    permissions.request(origin, permission).then(callback, () => callback(false));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => permissions.check(requestingOrigin, permission));
  ses.setDevicePermissionHandler(() => false);

  // Every download asks where to save, starting from a safe name. Nothing is saved or opened silently.
  ses.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ defaultPath: sanitizeFilename(item.getFilename()) });
  });

  // Requests the navigation policy cannot see (subresources) get a second check here.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(details.url)?.[1]?.toLowerCase();
    const type = details.resourceType;
    // Gopher opens raw TCP connections: allow it only as a top-level page the user can see,
    // never as an image, frame, script or fetch issued by a page.
    if (scheme === 'gopher' && type !== 'mainFrame') return callback({ cancel: true });
    // Internal pages are documents, never subresources of web pages.
    if (scheme === INTERNAL_SCHEME && type !== 'mainFrame') return callback({ cancel: true });
    callback({});
  });
}

export function hardenUiSession(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
  // The interface is local files only. It has no reason to reach the network.
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${CHROME_ORIGIN}/`) && !details.url.startsWith('devtools:') });
  });
}

const known = new WeakSet<WebContents>();

/** Mark a WebContents as one the browser created on purpose (a tab or a window's UI). */
export function adopt(wc: WebContents): void {
  known.add(wc);
}

/**
 * Backstop for anything the window code did not create itself: it may not
 * navigate, open windows or embed other contents.
 */
export function installGlobalGuards(): void {
  app.on('web-contents-created', (_event, wc) => {
    wc.on('will-attach-webview', (event) => event.preventDefault());
    // Give the creator one tick to adopt it; DevTools and unknown contents stay locked down.
    setImmediate(() => {
      if (wc.isDestroyed() || known.has(wc) || wc.getType() === 'remote' || wc.getURL().startsWith('devtools:')) return;
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-navigate', (event) => event.preventDefault());
    });
  });
}

export function sessions(): { ui: Session; web: Session } {
  return { ui: session.fromPartition(UI_PARTITION), web: session.fromPartition(WEB_PARTITION) };
}

/** Flags that turn a packaged build into a remote-control or unsandboxed one. */
export function hasUnsafeSwitches(argv: readonly string[]): string | undefined {
  return argv.find((a) => /^--(remote-debugging-(port|pipe|address)|inspect(-brk|-port)?|no-sandbox|disable-web-security|js-flags|load-extension|disable-site-isolation-trials)(=|$)/.test(a));
}
