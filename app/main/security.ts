import { app, type Session, type WebContents } from 'electron';
import { mediaPermission, type PermissionPolicy } from '../core/security/permissions.ts';
import { CHROME_ORIGIN, INTERNAL_SCHEME, RUFFLE_SCHEME } from '../core/security/url-policy.ts';

/**
 * Two sessions, never mixed:
 *  - the UI session holds only the browser's own interface and has no network access;
 *  - the web session holds everything the user browses.
 * They have separate storage, separate protocol handlers and separate rules.
 */
export const UI_PARTITION = 'anne-ui';
export const WEB_PARTITION = 'persist:web';

let privateCount = 0;
/** A fresh in-memory partition for one private window. Nothing in it is written to disk. */
export function newPrivatePartition(): string {
  return `anne-private-${++privateCount}`;
}

/** Renderer settings for web content. Nothing here may be loosened per tab. */
export function webPreferences(partition: string) {
  return { ...WEB_PREFERENCES_BASE, partition };
}

const WEB_PREFERENCES_BASE = {
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

/**
 * Tabs (by WebContents id) where the user has turned Flash emulation on.
 * Only these may load the emulator's files, so other pages cannot probe for
 * them to identify the browser.
 */
export const flashTabs = new Set<number>();

function originOf(url: string | undefined): string | undefined {
  try { return url ? new URL(url).origin : undefined; } catch { return undefined; }
}

/** What the certificate of a site looked like when Chromium last verified it. */
export interface CertificateSummary {
  subject: string;
  issuer: string;
  validFrom: number;
  validTo: number;
  fingerprint: string;
  /** Chromium's own verdict, e.g. `net::OK`. */
  verification: string;
}

const certificates = new Map<string, CertificateSummary>();
const MAX_CERTIFICATES = 500;

export function certificateFor(hostname: string): CertificateSummary | undefined {
  return certificates.get(hostname.toLowerCase());
}

export function hardenWebSession(ses: Session, policy: PermissionPolicy<WebContents>): void {
  // Present as the underlying engine. Naming the app adds a fingerprint and breaks user-agent checks.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|annes-browser)\/\S+/gi, ''));

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    // Only the top-level page's own origin may ask; embedded third-party frames may not.
    const origin = details.isMainFrame === false ? undefined : originOf(details.requestingUrl ?? wc?.getURL());
    if (!origin || !wc) return callback(false);
    const name = permission === 'media' ? mediaPermission((details as { mediaTypes?: string[] }).mediaTypes) : permission;
    policy.request(origin, name, wc).then(callback, () => callback(false));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const name = permission === 'media' ? mediaPermission([(details as { mediaType?: string }).mediaType ?? '']) : permission;
    return policy.check(requestingOrigin, name);
  });
  ses.setDevicePermissionHandler(() => false);

  // Record certificates for Page Info. The callback value -3 means "use Chromium's own
  // verification result": this hook only observes, and must never accept a certificate
  // Chromium rejected.
  ses.setCertificateVerifyProc((request, callback) => {
    const c = request.certificate;
    if (certificates.size >= MAX_CERTIFICATES) certificates.delete(certificates.keys().next().value!);
    certificates.set(request.hostname.toLowerCase(), {
      subject: c.subjectName, issuer: c.issuerName, validFrom: c.validStart * 1000, validTo: c.validExpiry * 1000,
      fingerprint: c.fingerprint, verification: request.verificationResult,
    });
    callback(-3);
  });

  // Requests the navigation policy cannot see (subresources) get a second check here.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(details.url)?.[1]?.toLowerCase();
    const type = details.resourceType;
    // Gopher opens raw TCP connections: allow it only as a top-level page the user can see,
    // never as an image, frame, script or fetch issued by a page.
    if (scheme === 'gopher' && type !== 'mainFrame') return callback({ cancel: true });
    // The Flash emulator's files load only in tabs where the user enabled it, and never as a page.
    if (scheme === RUFFLE_SCHEME && (type === 'mainFrame' || type === 'subFrame' || !flashTabs.has(details.webContentsId ?? -1))) {
      return callback({ cancel: true });
    }
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
