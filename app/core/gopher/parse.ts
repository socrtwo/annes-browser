/**
 * Gopher (RFC 1436) URL and menu parsing. Pure functions over bytes and
 * strings; no network access. Everything a server sends is untrusted.
 */

export class GopherError extends Error {
  readonly status: 400 | 403 | 502 | 504;
  constructor(message: string, status: 400 | 403 | 502 | 504) {
    super(message);
    this.status = status;
    this.name = 'GopherError';
  }
}

export interface GopherRequest {
  host: string;
  port: number;
  /** Item type character, e.g. `1` menu, `0` text, `7` search, `9` binary. */
  type: string;
  /** Selector bytes exactly as they go on the wire. */
  selector: Uint8Array;
  /** Search bytes for type 7, if supplied. */
  search?: Uint8Array;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;
const IPV6_LITERAL = /^\[[0-9a-f:.]{2,45}\]$/i;
const MAX_SELECTOR = 1024;

export function isValidHost(host: string): boolean {
  return HOSTNAME.test(host) || IPV6_LITERAL.test(host);
}

function percentDecode(text: string): Uint8Array {
  const out: number[] = [];
  const utf8 = new TextEncoder();
  for (let i = 0; i < text.length; i++) {
    const hex = text[i] === '%' ? /^[0-9a-f]{2}$/i.exec(text.slice(i + 1, i + 3)) : null;
    if (hex) { out.push(parseInt(hex[0], 16)); i += 2; } else out.push(...utf8.encode(text[i]!));
  }
  return Uint8Array.from(out);
}

/**
 * A selector is sent as one line. CR, LF and NUL would let a URL smuggle
 * extra lines to whatever service is listening, so they are rejected.
 */
function assertSafe(bytes: Uint8Array, what: string, allowTab: boolean): void {
  if (bytes.length > MAX_SELECTOR) throw new GopherError(`${what} is too long`, 400);
  for (const b of bytes) {
    if (b === 0x0d || b === 0x0a || b === 0x00 || (b === 0x09 && !allowTab)) {
      throw new GopherError(`${what} contains a control character`, 400);
    }
  }
}

/** Parse a `gopher://` URL into the request it denotes. Throws GopherError(400) if malformed. */
export function parseGopherUrl(url: string): GopherRequest {
  const m = /^gopher:\/\/([^/?#]*)([^#]*)/i.exec(url);
  if (!m) throw new GopherError('not a gopher URL', 400);
  const authority = m[1]!;
  let rest = m[2]!;
  if (authority.includes('@')) throw new GopherError('gopher URLs cannot carry credentials', 400);
  const hp = /^(\[[^\]]*\]|[^:]*)(?::(\d{1,5}))?$/.exec(authority);
  if (!hp || !isValidHost(hp[1]!)) throw new GopherError('invalid gopher host', 400);
  const host = hp[1]!.toLowerCase();
  const port = hp[2] === undefined ? 70 : Number(hp[2]);
  if (port < 1 || port > 65535) throw new GopherError('invalid gopher port', 400);

  if (rest.startsWith('/')) rest = rest.slice(1);
  if (rest === '') return { host, port, type: '1', selector: new Uint8Array() };
  const type = rest[0]!;
  if (!/^[0-9A-Za-z+:;<]$/.test(type)) throw new GopherError('invalid gopher item type', 400);
  rest = rest.slice(1);

  // A search form on a type-7 page submits `?q=text`.
  let formQuery: Uint8Array | undefined;
  if (type === '7') {
    const q = rest.indexOf('?');
    if (q >= 0) {
      const value = new URLSearchParams(rest.slice(q + 1)).get('q');
      if (value !== null) { formQuery = new TextEncoder().encode(value); rest = rest.slice(0, q); }
    }
  }

  const bytes = percentDecode(rest);
  const tab = bytes.indexOf(0x09);
  const selector = tab < 0 ? bytes : bytes.slice(0, tab);
  // Anything after a second tab is Gopher+ and is ignored.
  let search = formQuery;
  if (!search && tab >= 0) {
    const after = bytes.slice(tab + 1);
    const next = after.indexOf(0x09);
    search = next < 0 ? after : after.slice(0, next);
  }
  assertSafe(selector, 'selector', false);
  if (search) assertSafe(search, 'search text', false);
  return { host, port, type, selector, ...(search && { search }) };
}

/** The exact bytes to send for a request. */
export function requestBytes(req: GopherRequest): Uint8Array {
  const parts: number[] = [...req.selector];
  if (req.search) parts.push(0x09, ...req.search);
  parts.push(0x0d, 0x0a);
  return Uint8Array.from(parts);
}

export type Charset = 'utf-8' | 'latin1';

/** Decode server text: UTF-8 if valid, otherwise ISO-8859-1 (which maps every byte). */
export function decodeText(bytes: Uint8Array): { text: string; charset: Charset } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), charset: 'utf-8' };
  } catch {
    return { text: Buffer.from(bytes).toString('latin1'), charset: 'latin1' };
  }
}

/** Percent-encode selector bytes for use in a gopher URL path. */
export function encodeBytes(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9\-._~/]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function encodeSelector(selector: string, charset: Charset): string {
  return encodeBytes(charset === 'utf-8' ? new TextEncoder().encode(selector) : Buffer.from(selector, 'latin1'));
}

/** Canonical URL for a request, without any search text. */
export function gopherUrl(req: GopherRequest): string {
  const authority = req.port === 70 ? req.host : `${req.host}:${req.port}`;
  return `gopher://${authority}/${req.type}${encodeBytes(req.selector)}`;
}

export interface GopherItem {
  type: string;
  display: string;
  /** Where the item leads, if it is something this browser can open. */
  href?: string;
  /** Extra text for items that cannot be opened (telnet, CSO). */
  note?: string;
}

const MAX_ITEMS = 20000;
const MAX_DISPLAY = 2000;

/** Parse a menu (directory) response into items. Tolerant of malformed lines. */
export function parseMenu(text: string, charset: Charset): GopherItem[] {
  const items: GopherItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw === '.') break;
    if (raw === '') continue;
    if (items.length >= MAX_ITEMS) break;
    const type = raw[0]!;
    const [display = '', selector = '', host = '', portText = ''] = raw.slice(1).split('\t');
    const item: GopherItem = { type, display: display.slice(0, MAX_DISPLAY) };
    const port = /^\d{1,5}$/.test(portText.trim()) ? Number(portText.trim()) : NaN;
    const validTarget = isValidHost(host) && port >= 1 && port <= 65535;

    if (type === 'i' || type === '3' || !raw.includes('\t')) {
      if (!raw.includes('\t') && type !== 'i' && type !== '3') { item.type = 'i'; item.display = raw.slice(0, MAX_DISPLAY); }
    } else if (type === 'h' && /^\/?URL:/i.test(selector)) {
      const target = selector.replace(/^\/?URL:/i, '');
      // Only web and gopher links are followed; other schemes are shown as text.
      if (/^(https?|gopher):\/\//i.test(target) && URL.canParse(target)) item.href = target;
      else item.note = target.slice(0, 200);
    } else if (type === '8' || type === 'T') {
      item.note = validTarget ? `telnet ${host} ${port}` : 'telnet';
    } else if (type === '2') {
      item.note = 'CSO phone book (not supported)';
    } else if (validTarget && /^[0-9A-Za-z+:;<]$/.test(type) && !/[\r\n\0]/.test(selector)) {
      const authority = port === 70 ? host.toLowerCase() : `${host.toLowerCase()}:${port}`;
      item.href = `gopher://${authority}/${type}${encodeSelector(selector, charset)}`;
    }
    items.push(item);
  }
  return items;
}

/** Remove the lone "." terminator line some servers append to text files. */
export function stripTextTerminator(text: string): string {
  return text.replace(/\r?\n\.\r?\n?$/, '\n');
}

/** Identify an image by its leading bytes. Only these types are shown inline. */
export function sniffImage(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}
