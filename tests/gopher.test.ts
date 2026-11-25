import { connect, createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchGopher, handleGopherUrl } from '../app/core/gopher/client.ts';
import { decodeText, GopherError, gopherUrl, parseGopherUrl, parseMenu, requestBytes, sniffImage } from '../app/core/gopher/parse.ts';
import { escapeHtml, renderMenu } from '../app/core/gopher/render.ts';

const wire = (url: string) => Buffer.from(requestBytes(parseGopherUrl(url))).toString('latin1');

describe('gopher URLs', () => {
  it('parses host, port, type and selector', () => {
    expect(parseGopherUrl('gopher://Example.ORG')).toMatchObject({ host: 'example.org', port: 70, type: '1' });
    expect(parseGopherUrl('gopher://example.org:7070/0/docs/a%20b.txt')).toMatchObject({ port: 7070, type: '0' });
    expect(wire('gopher://example.org/0/docs/a%20b.txt')).toBe('/docs/a b.txt\r\n');
    expect(wire('gopher://example.org/')).toBe('\r\n');
    expect(wire('gopher://example.org/7/search%09cats')).toBe('/search\tcats\r\n');
    expect(wire('gopher://example.org/7/search?q=big+cats')).toBe('/search\tbig cats\r\n');
    expect(wire('gopher://example.org/1/a?b=c')).toBe('/a?b=c\r\n');
    expect(wire('gopher://example.org/0/caf%E9')).toBe('/caf\xe9\r\n');
    expect(gopherUrl(parseGopherUrl('gopher://example.org:7070/7/s%20x%09q'))).toBe('gopher://example.org:7070/7/s%20x');
  });

  it('rejects selectors that could carry extra protocol lines', () => {
    for (const url of [
      'gopher://example.org/1/x%0D%0AFLUSHALL', 'gopher://example.org/1/x%0Ay', 'gopher://example.org/1/x%0dy',
      'gopher://example.org/1/x%00y', 'gopher://example.org/7/s%09q%0D%0AEHLO', 'gopher://example.org/7/s?q=a%0D%0Ab',
      `gopher://example.org/1/${'a'.repeat(2000)}`,
    ]) expect(() => parseGopherUrl(url), url).toThrow(GopherError);
  });

  it('rejects malformed authorities', () => {
    for (const url of [
      'gopher://user:pw@example.org/', 'gopher://exa mple.org/', 'gopher://example.org:99999/', 'gopher://example.org:0/',
      'gopher:///1/x', 'gopher://ex%61mple.org/', 'gopher://example.org:70:80/', 'http://example.org/', 'gopher://-bad-.org/',
    ]) expect(() => parseGopherUrl(url), url).toThrow(GopherError);
  });
});

describe('gopher menus', () => {
  const menu = [
    'iWelcome\tfake\t(NULL)\t0',
    '1Sub menu\t/sub dir\texample.org\t70',
    '0Read me\t/read me.txt\tExample.org\t7070',
    'hWeb link\tURL:https://example.com/x\texample.org\t70',
    'hScript link\tURL:javascript:alert(1)\texample.org\t70',
    '8Telnet\t\tbbs.example.org\t23',
    '1Bad host\t/x\tevil host\t70',
    '1Bad port\t/x\texample.org\t99999',
    '3Not found\t\terror.host\t1',
    'a line with no tabs',
    '.',
    '1After terminator\t/x\texample.org\t70',
  ].join('\r\n');

  it('turns items into safe links', () => {
    const items = parseMenu(menu, 'utf-8');
    expect(items.map((i) => i.href)).toEqual([
      undefined, 'gopher://example.org/1/sub%20dir', 'gopher://example.org:7070/0/read%20me.txt',
      'https://example.com/x', undefined, undefined, undefined, undefined, undefined, undefined,
    ]);
    expect(items[4]?.note).toBe('javascript:alert(1)');
    expect(items[5]?.note).toBe('telnet bbs.example.org 23');
    expect(items[9]).toMatchObject({ type: 'i', display: 'a line with no tabs' });
  });

  it('keeps Latin-1 selectors byte-exact through a link', () => {
    const { text, charset } = decodeText(Buffer.from('1Caf\xe9\t/caf\xe9\texample.org\t70\r\n', 'latin1'));
    expect(charset).toBe('latin1');
    const href = parseMenu(text, charset)[0]!.href!;
    expect(href).toBe('gopher://example.org/1/caf%E9');
    expect(wire(href)).toBe('/caf\xe9\r\n');
  });

  it('escapes everything a server controls', () => {
    const hostile = parseMenu('1<img src=x onerror=alert(1)>\t/"><script>alert(2)</script>\texample.org\t70\r\ni</div><script>alert(3)</script>\t\t\t\r\n', 'utf-8');
    const html = renderMenu(parseGopherUrl('gopher://example.org/1/%3Cscript%3Ealert(4)%3C/script%3E'), hostile);
    expect(html).not.toMatch(/<script|<img|onerror=alert\(1\)>/i);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe('&#60;a href=&#34;x&#34; onclick=&#39;y&#39;&#62;&#38;');
  });

  it('survives random input', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 300; n++) {
      const bytes = Uint8Array.from({ length: Math.floor(rnd() * 400) }, () => {
        const r = rnd();
        return r < 0.15 ? 0x09 : r < 0.25 ? 0x0a : r < 0.3 ? 0x3c : Math.floor(rnd() * 256);
      });
      const { text, charset } = decodeText(bytes);
      const items = parseMenu(text, charset);
      const html = renderMenu({ host: 'example.org', port: 70, type: '1', selector: bytes.slice(0, 20) }, items);
      // Markup only ever comes from the renderer: every tag is one it writes itself.
      for (const tag of html.match(/<[^>]*>/g) ?? []) {
        expect(tag).toMatch(/^<(!doctype html|\/?(html|head|body|title|style|h1|div|span|a)\b[^<]*|meta [^<]*)>$/);
      }
      for (const it of items) {
        if (it.href) expect(() => parseGopherUrl(it.href!)).not.toThrow();
      }
    }
  });

  it('recognizes images by content, not by claimed type', () => {
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png');
    expect(sniffImage(Buffer.from('<html><script>'))).toBeUndefined();
    expect(sniffImage(Buffer.from('<svg xmlns='))).toBeUndefined();
  });
});

describe('gopher client', () => {
  let server: Server;
  let port: number;
  const received: string[] = [];
  const sockets = new Set<import('node:net').Socket>();

  beforeAll(async () => {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.once('data', (d) => {
        const line = d.toString('latin1');
        received.push(line);
        const sel = line.replace(/\r\n$/, '');
        if (sel === '') socket.end('iHello\t\t\t\r\n1Sub\t/sub\texample.org\t70\r\n.\r\n');
        else if (sel === '/text') socket.end('line one\r\nline two\r\n.\r\n');
        else if (sel === '/html') socket.end('<script>alert(1)</script><p>hi</p>');
        else if (sel === '/fake.gif') socket.end('<html><script>alert(1)</script>');
        else if (sel === '/real.gif') socket.end(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'));
        else if (sel === '/big') socket.end(Buffer.alloc(5000, 0x41));
        else if (sel === '/hang') { /* never answer */ }
        else if (sel.startsWith('/find\t')) socket.end(`0Result for ${sel.split('\t')[1]}\t/r\texample.org\t70\r\n.\r\n`);
        else socket.end('3Not found\t\terror.host\t1\r\n.\r\n');
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => { server.close(() => r()); for (const s of sockets) s.destroy(); }));

  const local = { allowPrivate: true, timeoutMs: 300 };
  const body = (r: { body: Uint8Array }) => Buffer.from(r.body).toString('utf8');

  it('refuses private and loopback servers unless explicitly allowed', async () => {
    const before = received.length;
    for (const host of ['127.0.0.1', 'localhost', '[::1]', '10.0.0.5', '169.254.169.254', '[::ffff:127.0.0.1]']) {
      const r = await handleGopherUrl(`gopher://${host}:${port}/`);
      expect(r.status, host).toBe(403);
    }
    expect(received.length).toBe(before);
  });

  it('refuses a name that resolves to any private address', async () => {
    const req = parseGopherUrl(`gopher://rebind.example:${port}/`);
    await expect(fetchGopher(req, { resolve: async () => ['93.184.216.34', '127.0.0.1'] })).rejects.toMatchObject({ status: 403 });
    await expect(fetchGopher(req, { resolve: async () => [] })).rejects.toMatchObject({ status: 502 });
  });

  it('connects to the address that passed the check', async () => {
    const seen: string[] = [];
    const req = parseGopherUrl(`gopher://pinned.example:${port}/`);
    const data = await fetchGopher(req, {
      allowPrivate: true,
      resolve: async () => ['127.0.0.1'],
      connect: (address, p) => { seen.push(address); return connect({ host: address, port: p }); },
    });
    expect(seen).toEqual(['127.0.0.1']);
    expect(data.toString()).toContain('Hello');
  });

  it('refuses ports used by other protocols', async () => {
    for (const p of [25, 6379, 11211, 22]) expect((await handleGopherUrl(`gopher://example.org:${p}/`)).status).toBe(403);
  });

  it('renders a menu as a locked-down page', async () => {
    const r = await handleGopherUrl(`gopher://127.0.0.1:${port}/`, local);
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(r.headers['Content-Security-Policy']).toMatch(/default-src 'none'.*sandbox allow-forms$/);
    expect(body(r)).toContain('<a href="gopher://example.org/1/sub">Sub</a>');
  });

  it('serves text as plain text without the terminator line', async () => {
    const r = await handleGopherUrl(`gopher://127.0.0.1:${port}/0/text`, local);
    expect(r.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(body(r)).toBe('line one\r\nline two\n');
  });

  it('serves HTML only under a policy that disables scripts', async () => {
    const r = await handleGopherUrl(`gopher://127.0.0.1:${port}/h/html`, local);
    expect(r.headers['Content-Security-Policy']).toMatch(/default-src 'none'.*sandbox$/);
    expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('shows real images inline and downloads everything else', async () => {
    expect((await handleGopherUrl(`gopher://127.0.0.1:${port}/g/real.gif`, local)).headers['Content-Type']).toBe('image/gif');
    const fake = await handleGopherUrl(`gopher://127.0.0.1:${port}/g/fake.gif`, local);
    expect(fake.headers['Content-Type']).toBe('application/octet-stream');
    expect(fake.headers['Content-Disposition']).toBe('attachment; filename="fake.gif"');
    const bin = await handleGopherUrl(`gopher://127.0.0.1:${port}/9/..%2F..%2Fx%22y.exe`, local);
    expect(bin.headers['Content-Disposition']).toBe('attachment; filename="x_y.exe"');
  });

  it('shows a search form, then results', async () => {
    const form = await handleGopherUrl(`gopher://127.0.0.1:${port}/7/find`, local);
    expect(body(form)).toContain(`<form method="get" action="gopher://127.0.0.1:${port}/7/find">`);
    const results = await handleGopherUrl(`gopher://127.0.0.1:${port}/7/find?q=cats`, local);
    expect(body(results)).toContain('Result for cats');
    expect(received.at(-1)).toBe('/find\tcats\r\n');
  });

  it('enforces size and time limits', async () => {
    const big = await handleGopherUrl(`gopher://127.0.0.1:${port}/9/big`, { ...local, maxBytes: 1000 });
    expect(big.status).toBe(502);
    expect(body(big)).toContain('too large');
    const hang = await handleGopherUrl(`gopher://127.0.0.1:${port}/1/hang`, { ...local, timeoutMs: 100 });
    expect(hang.status).toBe(504);
  });

  it('reports bad URLs and unreachable servers as error pages, never exceptions', async () => {
    expect((await handleGopherUrl('gopher://example.org/1/x%0D%0Ay')).status).toBe(400);
    expect((await handleGopherUrl('gopher://127.0.0.1:1/', local)).status).toBe(403);
    const closed = await handleGopherUrl('gopher://127.0.0.1:9/', local);
    expect(closed.status).toBe(403);
    const refused = await handleGopherUrl(`gopher://127.0.0.1:${port === 65000 ? 64999 : 65000}/`, local);
    expect(refused.status).toBe(502);
  });
});
