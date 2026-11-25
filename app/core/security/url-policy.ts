/**
 * Navigation policy: which URLs may load, depending on who asked.
 *
 * Every navigation in the browser (address bar, command, link click, script,
 * redirect, window.open) is passed through `decideNavigation` before it
 * loads. Anything not explicitly allowed is denied.
 */

/** Who initiated a navigation. */
export type Initiator =
  /** Typed or pasted into the address bar by the user. */
  | 'user-typed'
  /** A browser command acting for the user (bookmark, history, open file, palette). */
  | 'user-command'
  /** Page content: link click, script, form, redirect, window.open. Untrusted. */
  | 'web-content'
  /** The browser itself (startup page, stub explanations). */
  | 'internal';

export type NavigationDecision =
  | { action: 'allow'; url: string }
  /** Hand to another application, after asking the user. */
  | { action: 'external'; url: string; scheme: string }
  /** Run a catalog command instead (for example a legacy-protocol explanation). */
  | { action: 'command'; command: string; url: string }
  | { action: 'deny'; reason: string };

/** Internal scheme. `anne://chrome` is browser UI; `anne://pages` holds script-free internal pages. */
export const INTERNAL_SCHEME = 'anne';
export const CHROME_ORIGIN = `${INTERNAL_SCHEME}://chrome`;
export const PAGES_ORIGIN = `${INTERNAL_SCHEME}://pages`;

/**
 * Scheme that serves the bundled Flash emulator's own files to pages. It is
 * the only browser-provided scheme a page may load as a subresource, and only
 * in a tab where the user has turned Flash emulation on.
 */
export const RUFFLE_SCHEME = 'anne-ruffle';
export const RUFFLE_BASE = `${RUFFLE_SCHEME}://app/`;

/** Schemes passed to other applications. Each use is confirmed by the user. */
export const EXTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  'mailto', 'tel', 'sms', 'magnet', 'irc', 'ircs', 'news', 'nntp', 'geo', 'xmpp', 'webcal',
]);

/** Legacy schemes handled by a catalog command. */
const COMMAND_SCHEMES: Readonly<Record<string, string>> = { ftp: 'legacy.ftp-open' };

const MAX_URL_LENGTH = 2 * 1024 * 1024;

const deny = (reason: string): NavigationDecision => ({ action: 'deny', reason });

export interface NavigationRequest {
  url: string;
  initiator: Initiator;
  /** URL of the page that initiated a `web-content` navigation, if known. */
  from?: string;
}

function schemeOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try { return new URL(url).protocol.slice(0, -1); } catch { return undefined; }
}

export function decideNavigation(req: NavigationRequest): NavigationDecision {
  if (req.url.length > MAX_URL_LENGTH) return deny('URL is too long');
  let u: URL;
  try { u = new URL(req.url); } catch { return deny('not a valid URL'); }
  const scheme = u.protocol.slice(0, -1);
  const url = u.href;
  const trusted = req.initiator !== 'web-content';

  switch (scheme) {
    case 'http':
    case 'https':
    case 'gopher':
      return { action: 'allow', url };

    case INTERNAL_SCHEME:
      // Browser UI is never a navigation target. Internal pages open only for the
      // browser or the user, or from another internal page.
      if (u.host !== 'pages') return deny('browser UI is not a page');
      if (trusted || schemeOf(req.from) === INTERNAL_SCHEME) return { action: 'allow', url };
      return deny('web pages may not open internal pages');

    case 'file':
      // Local files open only for the user, or from another local file.
      if (trusted || schemeOf(req.from) === 'file') return { action: 'allow', url };
      return deny('web pages may not open local files');

    case 'about':
      return url === 'about:blank' || url === 'about:srcdoc' ? { action: 'allow', url } : deny('unsupported about: page');

    case 'blob':
      // Created by the page itself; the engine enforces same-origin use.
      return trusted ? deny('blob: URLs cannot be opened directly') : { action: 'allow', url };

    case 'view-source': {
      if (!trusted) return deny('web pages may not open view-source');
      const inner = schemeOf(url.slice('view-source:'.length));
      return inner && ['http', 'https', 'file', 'gopher'].includes(inner)
        ? { action: 'allow', url }
        : deny('view-source supports only http, https, file and gopher pages');
    }

    case 'data':
      return deny('data: URLs cannot be opened as pages');
    case 'javascript':
    case 'vbscript':
      return deny(`${scheme}: URLs are not run`);
  }

  const command = COMMAND_SCHEMES[scheme];
  if (command) return { action: 'command', command, url };
  if (EXTERNAL_SCHEMES.has(scheme)) return { action: 'external', url, scheme };
  return deny(`unsupported scheme "${scheme}"`);
}

/**
 * Sub-frame navigations: frames may load web content only. They can never
 * reach internal pages, local files (unless the parent is a local file) or
 * other applications.
 */
export function decideFrameNavigation(url: string, parentUrl: string | undefined): NavigationDecision {
  const scheme = schemeOf(url);
  if (scheme === undefined) return deny('not a valid URL');
  if (['http', 'https', 'blob', 'data'].includes(scheme) || url === 'about:blank' || url === 'about:srcdoc') {
    return { action: 'allow', url };
  }
  if (scheme === 'file' && schemeOf(parentUrl) === 'file') return { action: 'allow', url };
  return deny(`frames may not load ${scheme}: URLs`);
}

export type AddressInput = { kind: 'url'; url: string } | { kind: 'search'; query: string } | { kind: 'empty' };

const SCHEMES_WITHOUT_SLASHES = new Set(['about', 'view-source', 'data', 'javascript', 'blob', ...EXTERNAL_SCHEMES]);
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;

function looksLikeHost(host: string): 'local' | 'public' | undefined {
  if (/^\[[0-9a-f:.]+\]$/i.test(host)) return 'local';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'local';
  if (host.toLowerCase() === 'localhost') return 'local';
  const labels = host.replace(/\.$/, '').split('.');
  if (labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l))) return undefined;
  // The last label must look like a top-level domain, so "file.txt" is still
  // ambiguous but "3.14" and "e.g" are searches.
  return /^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i.test(labels.at(-1)!) ? 'public' : undefined;
}

/**
 * Interpret address-bar text as a URL or a search. The result is not yet
 * authorized: pass a `url` result through `decideNavigation` with initiator
 * `user-typed`.
 */
export function interpretAddressInput(text: string): AddressInput {
  // Control characters (including newlines from a paste) never belong in a URL.
  // eslint-disable-next-line no-control-regex
  const input = text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (input === '') return { kind: 'empty' };
  if (/\s/.test(input)) return { kind: 'search', query: input };

  const scheme = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(input);
  if (scheme) {
    const [, name, rest] = scheme as unknown as [string, string, string];
    const hasSlashes = rest.startsWith('//');
    // "localhost:8080/x" and "example.com:443" are host:port, not a scheme.
    const isHostPort = !hasSlashes && /^\d{1,5}(\/|$)/.test(rest) && looksLikeHost(name) !== undefined;
    if (!isHostPort && (hasSlashes || SCHEMES_WITHOUT_SLASHES.has(name.toLowerCase()))) {
      return URL.canParse(input) ? { kind: 'url', url: input } : { kind: 'search', query: input };
    }
    if (!isHostPort) return { kind: 'search', query: input };
  }

  const authority = /^[^/?#]*/.exec(input)![0];
  const host = authority.replace(/^[^@]*@/, '').replace(/:\d{1,5}$/, '');
  const kind = looksLikeHost(host);
  if (kind === undefined) return { kind: 'search', query: input };
  // Names default to HTTPS. Literal addresses and localhost are usually local
  // development servers, which rarely have certificates.
  const url = `${kind === 'public' ? 'https' : 'http'}://${input}`;
  return URL.canParse(url) ? { kind: 'url', url } : { kind: 'search', query: input };
}

/** Build a search URL from a template containing `%s`. */
export function searchUrl(template: string, query: string): string {
  return template.replace('%s', encodeURIComponent(query));
}

/**
 * URL text for the address bar. Hides embedded credentials, which are used
 * to disguise the real host ("https://bank.example@evil.example"). Hosts
 * stay in ASCII (punycode) form so look-alike characters are visible.
 */
export function displayUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  if (u.username || u.password) { u.username = ''; u.password = ''; }
  return u.href;
}
