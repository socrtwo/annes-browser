import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { app, protocol, type Session } from 'electron';
import type { CommandRecord } from '../core/catalog/types.ts';
import { handleGopherUrl } from '../core/gopher/client.ts';
import {
  aboutPage, archaeologyPage, blockedPage, homePage, INTERNAL_PAGE_CSP, notFoundPage, stubPage,
} from '../core/pages.ts';
import { INTERNAL_SCHEME, RUFFLE_SCHEME } from '../core/security/url-policy.ts';

/**
 * Development builds can be told to reach a Gopher server on this machine, so
 * the end-to-end test can run one. Packaged builds ignore the variable.
 */
const DEV_ALLOW_PRIVATE_GOPHER = !app.isPackaged && process.env['ANNE_DEV_GOPHER_PRIVATE'] === '1';

/** Must run before the app is ready. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: INTERNAL_SCHEME, privileges: { standard: true, secure: true } },
    // The emulator's script and WebAssembly are fetched by the page it runs in, so this
    // scheme must be fetchable cross-origin and exempt from that page's content policy.
    // Nothing else is served from it, and security.ts limits which tabs may request it.
    { scheme: RUFFLE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } },
  ]);
  // Gopher is deliberately NOT registered as a standard scheme: Chromium gives
  // custom standard schemes no port, and would silently rewrite
  // gopher://host:7070/ to gopher://host/. Left unregistered, the URL is kept
  // exactly as written, and each gopher page gets an opaque origin.
}

const UI_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  "require-trusted-types-for 'script'", "trusted-types 'none'",
].join('; ');

const UI_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
};

const COMMON = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

/** Serve the browser's own interface files at anne://chrome/ in the UI session only. */
export function serveUi(ses: Session, uiDir: string): void {
  ses.protocol.handle(INTERNAL_SCHEME, async (request) => {
    const url = new URL(request.url);
    const type = UI_TYPES[extname(url.pathname)];
    // Resolve inside the UI directory only; reject anything that escapes it.
    const file = normalize(join(uiDir, decodeURIComponent(url.pathname)));
    if (url.host !== 'chrome' || request.method !== 'GET' || !type || !file.startsWith(uiDir + sep)) {
      return new Response('Not found', { status: 404, headers: COMMON });
    }
    try {
      return new Response(await readFile(file), { headers: { ...COMMON, 'Content-Type': type, 'Content-Security-Policy': UI_CSP } });
    } catch {
      return new Response('Not found', { status: 404, headers: COMMON });
    }
  });
}

const RUFFLE_FILE = /^\/(ruffle\.js|[A-Za-z0-9_.-]+\.wasm)$/;

/** Serve the bundled Flash emulator's files in the web session. */
export function serveRuffle(ses: Session, ruffleDir: string): void {
  ses.protocol.handle(RUFFLE_SCHEME, async (request) => {
    const url = new URL(request.url);
    // A fixed pattern, not a path join: only the emulator's own top-level files exist here.
    if (url.host !== 'app' || request.method !== 'GET' || !RUFFLE_FILE.test(url.pathname)) {
      return new Response('Not found', { status: 404, headers: COMMON });
    }
    try {
      return new Response(await readFile(join(ruffleDir, url.pathname.slice(1))), {
        headers: {
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'max-age=86400',
          'Access-Control-Allow-Origin': '*',
          'Content-Type': url.pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
        },
      });
    } catch {
      return new Response('Not found', { status: 404, headers: COMMON });
    }
  });
}

export interface PageSources {
  visibleCommands(): CommandRecord[];
  command(id: string): CommandRecord | undefined;
}

/** Serve script-free internal pages (anne://pages/) and Gopher in the web session. */
export function serveWeb(ses: Session, src: PageSources): void {
  const html = (body: string, status = 200) =>
    new Response(body, { status, headers: { ...COMMON, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': INTERNAL_PAGE_CSP } });

  ses.protocol.handle(INTERNAL_SCHEME, (request) => {
    const url = new URL(request.url);
    // The browser UI does not exist in this session.
    if (url.host !== 'pages' || request.method !== 'GET') return html(notFoundPage(), 404);
    switch (url.pathname) {
      case '/home': return html(homePage());
      case '/about': return html(aboutPage(app.getVersion(), `Chromium ${process.versions.chrome}, Electron ${process.versions.electron}`));
      case '/archaeology': return html(archaeologyPage(src.visibleCommands()));
      case '/stub': return html(stubPage(src.command(url.searchParams.get('id') ?? '')));
      case '/blocked': return html(blockedPage(url.searchParams.get('url') ?? '', url.searchParams.get('reason') ?? 'This address cannot be opened.'));
      default: return html(notFoundPage(), 404);
    }
  });

  ses.protocol.handle('gopher', async (request) => {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: COMMON });
    const r = await handleGopherUrl(request.url, { allowPrivate: DEV_ALLOW_PRIVATE_GOPHER });
    return new Response(Buffer.from(r.body), { status: r.status, headers: r.headers });
  });
}
