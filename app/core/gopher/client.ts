import { lookup } from 'node:dns/promises';
import { connect, isIP, type Socket } from 'node:net';
import { sanitizeFilename } from '../security/downloads.ts';
import { isPublicAddress, isRestrictedPort } from '../security/net-policy.ts';
import {
  decodeText, GopherError, type GopherRequest, gopherUrl, parseGopherUrl, parseMenu, requestBytes, sniffImage,
  stripTextTerminator,
} from './parse.ts';
import { GOPHER_HTML_CSP, GOPHER_PAGE_CSP, gopherTitle, renderError, renderMenu, renderSearch } from './render.ts';

export interface GopherOptions {
  /** Allow loopback and private-network servers. Off by default; never set from page input. */
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  /** Replaceable for tests. */
  resolve?: (host: string) => Promise<string[]>;
  connect?: (address: string, port: number) => Socket;
}

const DEFAULT_TIMEOUT = 20_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

/**
 * Fetch one Gopher item. The host is resolved once and the connection goes to
 * that exact address, so the address that passed the policy check is the one
 * used (no second lookup an attacker could answer differently).
 */
export async function fetchGopher(req: GopherRequest, opts: GopherOptions = {}): Promise<Buffer> {
  if (isRestrictedPort(req.port)) throw new GopherError(`port ${req.port} is not allowed for gopher`, 403);
  const bare = req.host.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(bare) ? [bare] : await (opts.resolve ?? defaultResolve)(bare);
  } catch {
    throw new GopherError(`cannot find server ${req.host}`, 502);
  }
  if (addresses.length === 0) throw new GopherError(`cannot find server ${req.host}`, 502);
  // Every address must be public: a name that resolves to both a public and a
  // private address is treated as hostile.
  if (!opts.allowPrivate && !addresses.every(isPublicAddress)) {
    throw new GopherError(`${req.host} is on this computer or a private network`, 403);
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  return new Promise<Buffer>((resolve, reject) => {
    const socket = (opts.connect ?? ((address, port) => connect({ host: address, port })))(addresses[0]!, req.port);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: GopherError) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error); else resolve(Buffer.concat(chunks));
    };
    // One overall deadline plus an idle timeout: a server cannot hold the connection open by trickling bytes.
    const deadline = setTimeout(() => finish(new GopherError('the server took too long', 504)), timeoutMs * 3);
    socket.setTimeout(timeoutMs, () => finish(new GopherError('the server stopped responding', 504)));
    socket.once('connect', () => socket.write(requestBytes(req)));
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) return finish(new GopherError('the response is too large', 502));
      chunks.push(chunk);
    });
    socket.once('end', () => finish());
    socket.once('error', () => finish(new GopherError(`cannot connect to ${req.host}`, 502)));
  });
}

export interface GopherResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

function html(status: number, body: string, csp = GOPHER_PAGE_CSP): GopherResponse {
  return {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp },
    body: new TextEncoder().encode(body),
  };
}

const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/** Load a `gopher://` URL and turn the result into a response the browser can display. Never throws. */
export async function handleGopherUrl(url: string, opts: GopherOptions = {}): Promise<GopherResponse> {
  let req: GopherRequest;
  try {
    req = parseGopherUrl(url);
  } catch (e) {
    return html(400, renderError('Gopher', e instanceof GopherError ? e.message : 'invalid gopher URL'));
  }
  try {
    if (req.type === '7' && !req.search) return html(200, renderSearch(req, gopherUrl(req)));
    const isListing = req.type === '1' || req.type === '7';
    const data = await fetchGopher(req, {
      ...opts,
      maxBytes: Math.min(opts.maxBytes ?? Infinity, isListing || req.type === '0' ? MAX_TEXT_BYTES : DEFAULT_MAX_BYTES),
    });

    if (isListing) {
      const { text, charset } = decodeText(data);
      const items = parseMenu(text, charset);
      if (req.type === '1') return html(200, renderMenu(req, items));
      return html(200, renderSearch(req, gopherUrl(req), items));
    }
    if (req.type === '0') {
      const { text } = decodeText(data);
      return {
        status: 200,
        headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
        body: new TextEncoder().encode(stripTextTerminator(text)),
      };
    }
    if (req.type === 'h') {
      return { status: 200, headers: { ...BASE_HEADERS, 'Content-Type': 'text/html', 'Content-Security-Policy': GOPHER_HTML_CSP }, body: data };
    }
    const image = ['g', 'I', 'p'].includes(req.type) ? sniffImage(data) : undefined;
    if (image) return { status: 200, headers: { ...BASE_HEADERS, 'Content-Type': image }, body: data };

    // Everything else is offered as a download, never rendered.
    const name = sanitizeFilename(Buffer.from(req.selector).toString('latin1').replace(/[^\x20-\x7e]/g, '_'), 'gopher-download');
    return {
      status: 200,
      headers: {
        ...BASE_HEADERS,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name.replace(/["\\]/g, '_')}"`,
      },
      body: data,
    };
  } catch (e) {
    const err = e instanceof GopherError ? e : new GopherError('gopher request failed', 502);
    return html(err.status, renderError(gopherTitle(req), err.message));
  }
}
