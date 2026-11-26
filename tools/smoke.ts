/**
 * End-to-end check of the built app in a real Electron process.
 *
 *   npm run smoke          (needs a display; on a headless machine: xvfb-run -a npm run smoke)
 *
 * Drives the app through Playwright and asserts the security boundaries hold
 * in the running browser, not just in unit tests. Uses local HTTP and Gopher
 * servers; makes no outside connections.
 */
import { createServer as createHttp } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createTcp } from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttps } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright-core') as typeof import('playwright-core');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 8000): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  return undefined;
}

/** The smallest valid Flash movie: a 100x100 stage, one frame, a background colour. */
function minimalSwf(): Buffer {
  const bits = '01100' + [0, 2000, 0, 2000].map((v) => v.toString(2).padStart(12, '0')).join('');
  const rect = Buffer.from((bits.padEnd(56, '0').match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const body = Buffer.concat([rect, Buffer.from([0x00, 0x0c, 0x01, 0x00]), Buffer.from([0x43, 0x02, 0x10, 0x80, 0xc0]), Buffer.from([0x40, 0x00, 0x00, 0x00])]);
  const header = Buffer.from([0x46, 0x57, 0x53, 0x06, 0, 0, 0, 0]);
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

// ---- local servers ----
const httpHits: string[] = [];
const http = createHttp((req, res) => {
  httpHits.push(req.url ?? '');
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/redirect-file') { res.statusCode = 302; res.setHeader('Location', 'file:///etc/passwd'); return res.end(); }
  if (req.url === '/redirect-internal') { res.statusCode = 302; res.setHeader('Location', 'anne://pages/about'); return res.end(); }
  if (req.url === '/find') return res.end('<title>find page</title><p>apple banana apple cherry apple</p>');
  if (req.url === '/file.txt') { res.setHeader('Content-Type', 'text/plain'); res.setHeader('Content-Disposition', 'attachment; filename="notes.txt"'); return res.end('plain text'); }
  if (req.url === '/tool.exe') { res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Disposition', 'attachment; filename="tool.exe"'); return res.end('MZ fake'); }
  if (req.url === '/perm') return res.end(`<title>perm</title><iframe src="http://localhost:${httpPort}/inner"></iframe>`);
  if (req.url === '/inner') return res.end('<title>inner</title><p>inner frame</p>');
  if (req.url === '/links') return res.end('<title>links</title><a id="good" href="/linked" style="display:block;padding:20px">good link</a><a id="bad" href="javascript:alert(1)" style="display:block;padding:20px">bad link</a>');
  if (req.url === '/test.swf') { res.setHeader('Content-Type', 'application/x-shockwave-flash'); return res.end(minimalSwf()); }
  if (req.url === '/flash') return res.end('<title>flash page</title><embed id="movie" src="/test.swf" type="application/x-shockwave-flash" width="100" height="100">');
  res.end(`<title>page ${req.url}</title><body>hello <a id="l" href="/b">b</a></body>`);
});
await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
const httpPort = (http.address() as { port: number }).port;
const base = `http://127.0.0.1:${httpPort}`;

const gopherHits: string[] = [];
const gopher = createTcp((socket) => {
  socket.once('data', (d) => {
    const sel = d.toString('latin1').replace(/\r\n$/, '');
    gopherHits.push(sel);
    if (sel === '') socket.end('iWelcome <script>document.title="PWNED"</script>\t\t\t\r\n1Sub\t/sub\t127.0.0.1\t' + gopherPort + '\r\n.\r\n');
    else if (sel.startsWith('/find\t')) socket.end(`iResult for ${sel.split('\t')[1]}\t\t\t\r\n.\r\n`);
    else if (sel === '/evil.html') socket.end('<title>gopher html</title><script>document.title="PWNED"</script><p id="p">inert</p>');
    else socket.end('iempty\t\t\t\r\n.\r\n');
  });
  socket.on('error', () => {});
});
await new Promise<void>((r) => gopher.listen(0, '127.0.0.1', r));
const gopherPort = (gopher.address() as { port: number }).port;

// ---- a self-signed HTTPS server, to prove certificate checks were not weakened ----
let https: import('node:https').Server | undefined;
let httpsPort = 0;
try {
  const certDir = mkdtempSync(join(tmpdir(), 'anne-smoke-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')], { stdio: 'ignore' });
  https = createHttps({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) },
    (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>secret</title>self-signed'); });
  await new Promise<void>((r) => https!.listen(0, '127.0.0.1', r));
  httpsPort = (https.address() as { port: number }).port;
} catch {
  console.log('note: openssl unavailable; skipping the certificate check');
}

// ---- launch ----
// A throwaway profile and download folder: the test never touches a real profile.
const userData = mkdtempSync(join(tmpdir(), 'anne-smoke-profile-'));
const downloadDir = mkdtempSync(join(tmpdir(), 'anne-smoke-downloads-'));
const launch = (env: Record<string, string>) => _electron.launch({
  executablePath: require('electron') as unknown as string,
  // --no-sandbox only because CI containers run as root; the app itself enables the sandbox.
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), root],
  env: { ...process.env, ANNE_DEV_USER_DATA: userData, ANNE_DEV_DOWNLOAD_DIR: downloadDir, ...env } as Record<string, string>,
});
const app = await launch({ ANNE_DEV_GOPHER_PRIVATE: '1' });
const pages = () => app.windows();
const maybeUi = await until(() => pages().find((p) => p.url().startsWith('anne://chrome/')));
check('UI loads from anne://chrome', !!maybeUi);
if (!maybeUi) { await app.close(); process.exit(1); }
const ui = maybeUi;
const tabs = () => pages().filter((p) => p !== ui && !p.url().startsWith('devtools:'));
const tabWith = (part: string) => until(() => tabs().find((p) => p.url().includes(part)));
const windowCount = () => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length);
const uiState = () => ui.evaluate(() => ({
  tabs: document.querySelectorAll('.tab').length,
  address: (document.getElementById('address') as HTMLInputElement).value,
  palette: !document.getElementById('palette')!.hidden,
  notice: document.getElementById('notice')!.textContent,
}));
const go = async (text: string) => {
  await ui.evaluate((t) => window.anne.execute({ id: 'nav.go', source: 'toolbar', args: { text: t } }), text);
};

check('home page opens in a tab', !!(await tabWith('anne://pages/home')));
await until(async () => (await uiState()).tabs === 1);

// ---- UI renderer is locked down ----
const uiProbe = await ui.evaluate(async () => {
  const w = window as unknown as Record<string, unknown>;
  let html = 'allowed';
  try { document.createElement('div').innerHTML = '<img src=x onerror=1>'; } catch { html = 'blocked'; }
  let net = 'allowed';
  try { await fetch('https://example.com/'); } catch { net = 'blocked'; }
  // Run from a timer: code evaluated through the DevTools protocol is exempt from the eval ban.
  const evalResult = await new Promise<string>((r) => setTimeout(() => {
    try { new Function('return 1')(); r('allowed'); } catch { r('blocked'); }
  }, 0));
  return { node: typeof w['require'] + typeof w['process'] + typeof w['Buffer'], api: Object.keys(w['anne'] as object).sort().join(), html, net, evalResult };
});
check('UI has no Node access', uiProbe.node === 'undefinedundefinedundefined', uiProbe.node);
check('UI bridge exposes exactly five functions', uiProbe.api === 'closeOverlay,execute,list,onState,paletteSearch', uiProbe.api);
check('UI cannot assign HTML strings (Trusted Types)', uiProbe.html === 'blocked');
check('UI cannot reach the network', uiProbe.net === 'blocked');
check('UI cannot eval', uiProbe.evalResult === 'blocked');
const forged = await ui.evaluate(() => Promise.all([
  window.anne.execute({ id: 'nav.go', source: 'internal' as never, args: { text: 'x' } }),
  window.anne.execute({ id: 'nav.go', source: 'toolbar', args: { text: 'x', __proto__: { a: 1 } } as never, extra: 1 } as never),
  window.anne.execute({ id: 'no.such-command', source: 'toolbar' }),
  window.anne.execute({ id: 'tab.select', source: 'toolbar', args: { index: 'one' as never } }),
]) as Promise<{ ok: boolean; reason?: string }[]>);
check('IPC rejects forged source, extra fields, unknown commands, bad argument types', forged.every((r) => !r.ok), forged.map((r) => r.reason).join());

// ---- navigation from the address bar ----
await go(`${base}/a`);
const web = await tabWith(`${base}/a`);
check('address bar navigates the active tab', !!web);
if (!web) { await app.close(); process.exit(1); }
await until(async () => (await uiState()).address === `${base}/a`);
check('address bar shows the page URL', (await uiState()).address === `${base}/a`);
const webProbe = await web.evaluate(() => {
  const w = window as unknown as Record<string, unknown>;
  return typeof w['anne'] + typeof w['require'] + typeof w['process'];
});
check('web pages get no bridge and no Node access', webProbe === 'undefinedundefinedundefined', webProbe);

// ---- web content cannot escape ----
const stays = async (name: string, js: string) => {
  await web.evaluate(js).catch(() => {});
  await sleep(500);
  check(name, web.url() === `${base}/a`, web.url());
};
await stays('page cannot navigate to a local file', "location.href = 'file:///etc/passwd'");
await stays('page cannot navigate to an internal page', "location.href = 'anne://pages/about'");
await stays('page cannot navigate to browser UI', "location.href = 'anne://chrome/index.html'");
await stays('page cannot navigate to a data: URL', "location.href = 'data:text/html,<h1>x</h1>'");
const subresource = await web.evaluate(async (port) => {
  const tryFetch = (u: string) => fetch(u, { mode: 'no-cors' }).then(() => 'loaded', () => 'blocked');
  const tryImg = (u: string) => new Promise<string>((r) => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('blocked'); i.src = u; });
  const tryFrame = (u: string) => new Promise<string>((r) => {
    const f = document.createElement('iframe');
    f.onload = () => { try { r(f.contentDocument ? 'blank' : 'loaded'); } catch { r('loaded'); } };
    f.src = u; document.body.append(f); setTimeout(() => r('blocked'), 1500);
  });
  return {
    fetchInternal: await tryFetch('anne://pages/home'),
    fetchUi: await tryFetch('anne://chrome/chrome.js'),
    imgGopher: await tryImg(`gopher://127.0.0.1:${port}/g/x.gif`),
    fetchGopher: await tryFetch(`gopher://127.0.0.1:${port}/1/probe`),
    frameInternal: await tryFrame('anne://pages/home'),
    frameGopher: await tryFrame(`gopher://127.0.0.1:${port}/1/frameprobe`),
    frameFile: await tryFrame('file:///etc/passwd'),
  };
}, gopherPort);
check('page cannot load internal pages or UI files as subresources', subresource.fetchInternal === 'blocked' && subresource.fetchUi === 'blocked', JSON.stringify(subresource));
check('page cannot frame internal pages, gopher or local files', [subresource.frameInternal, subresource.frameGopher, subresource.frameFile].every((v) => v !== 'loaded'), JSON.stringify(subresource));
check('page cannot make gopher requests (no connection reached the server)', gopherHits.length === 0, gopherHits.join('|'));

await go(`${base}/redirect-file`);
await sleep(800);
check('redirect to a local file is refused', !tabs().some((p) => p.url().startsWith('file:')), tabs().map((p) => p.url()).join());
await go(`${base}/redirect-internal`);
await sleep(800);
check('redirect to an internal page is refused', !tabs().some((p) => p.url().startsWith('anne://pages/about')));
await go(`${base}/a`);
await until(() => web.url() === `${base}/a`);

const before = tabs().length;
await web.evaluate((b) => { window.open(`${b}/popup`); window.open('file:///etc/passwd'); window.open('anne://pages/about'); }, base);
const popup = await tabWith('/popup');
await sleep(500);
check('window.open becomes one new tab, and only for allowed URLs', !!popup && tabs().length === before + 1, `${tabs().length - before} new`);
check('no extra windows were created', (await windowCount()) === 1);

// ---- keys, palette, stubs ----
const countTabs = async () => (await uiState()).tabs;
// Native key events. (Keys injected through the DevTools protocol skip Electron's
// before-input-event, so Playwright's keyboard API cannot exercise the dispatcher.)
const press = (urlPrefix: string, keyCode: string, modifiers: string[] = []) =>
  app.evaluate(({ webContents }, a) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(a.urlPrefix));
    if (!wc) throw new Error(`no contents at ${a.urlPrefix}`);
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: a.keyCode, modifiers: a.modifiers as never });
    wc.sendInputEvent({ type: 'keyUp', keyCode: a.keyCode, modifiers: a.modifiers as never });
  }, { urlPrefix, keyCode, modifiers });
let n = await countTabs();
await press(`${base}/popup`, 'T', ['control']);
check('Ctrl+T from a page opens a tab', !!(await until(async () => (await countTabs()) === n + 1)), `${await countTabs()} vs ${n}`);
n = await countTabs();
await tabWith('anne://pages/home');
await press('anne://pages/home', 'W', ['control']);
check('Ctrl+W closes a tab', !!(await until(async () => (await countTabs()) === n - 1)));

await press('anne://chrome/', 'F2');
check('F2 opens the command palette', !!(await until(async () => (await uiState()).palette)));
await ui.locator('#palette-input').fill('about anne');
await until(() => ui.evaluate(() => document.querySelectorAll('#palette-list li').length > 0));
await ui.keyboard.press('Enter');
check('palette runs the chosen command', !!(await tabWith('anne://pages/about')));
check('palette closes after running', !(await uiState()).palette);

await ui.evaluate(() => window.anne.execute({ id: 'legacy.activex', source: 'palette' }));
const stub = await tabWith('anne://pages/stub');
check('a retired command opens its explanation page', !!stub && (await stub.textContent('body'))!.includes('cannot be run safely'));
await ui.evaluate(() => window.anne.execute({ id: 'legacy.ftp-open', source: 'palette' }));
check('an unbuilt command says so', !!(await until(async () => (await uiState()).notice?.includes('not built yet'))), (await uiState()).notice ?? '');

await go('javascript:alert(1)');
check('javascript: in the address bar shows the blocked page', !!(await tabWith('anne://pages/blocked')));

// ---- gopher end to end ----
gopherHits.length = 0;
await go(`gopher://127.0.0.1:${gopherPort}/`);
const gmenu = await tabWith(`gopher://127.0.0.1:${gopherPort}`);
const gtext = gmenu ? await until(async () => ((await gmenu.textContent('body')) ?? '').includes('Welcome') && gmenu.textContent('body')) : undefined;
check('gopher menu renders', !!gtext && gopherHits.includes(''));
check('script in gopher menu text is inert', !!gmenu && (await gmenu.title()) !== 'PWNED' && (gtext as string ?? '').includes('<script>'), gmenu ? await gmenu.title() : '');
check('gopher menu links resolve', !!gmenu && (await gmenu.getAttribute('a', 'href')) === `gopher://127.0.0.1:${gopherPort}/1/sub`);
await go(`gopher://127.0.0.1:${gopherPort}/h/evil.html`);
const ghtml = await tabWith('/h/evil.html');
await until(async () => !!ghtml && !!(await ghtml.$('#p')));
check('HTML served over gopher renders without running script', !!ghtml && (await ghtml.title()) === 'gopher html', ghtml ? await ghtml.title() : 'no tab');

await go(`gopher://127.0.0.1:${gopherPort}/7/find`);
const gsearch = await tabWith('/7/find');
await until(async () => !!gsearch && !!(await gsearch.$('input[name=q]')));
await gsearch?.fill('input[name=q]', 'big cats');
await gsearch?.press('input[name=q]', 'Enter');
check('gopher search form submits the query', !!(await until(() => gopherHits.includes('/find\tbig cats'))), gopherHits.join('|'));

// ---- Flash emulation ----
await go(`${base}/flash`);
const flash = await tabWith('/flash');
await until(async () => !!flash && !!(await flash.$('#movie')));
const probeRuffle = () => flash!.evaluate(() => fetch('anne-ruffle://app/ruffle.js').then((r) => (r.ok ? 'loaded' : 'blocked'), () => 'blocked'));
check('emulator files are not reachable before the user turns Flash on', (await probeRuffle()) === 'blocked');
await ui.evaluate(() => window.anne.execute({ id: 'tab.select', source: 'toolbar', args: { index: 1 } }));
await sleep(300);
const other = tabs().find((p) => p.url() === `${base}/a`);
const flashIndex = await ui.evaluate(() => [...document.querySelectorAll('.tab')].findIndex((t) => t.textContent!.includes('flash page')) + 1);
await ui.evaluate((i) => window.anne.execute({ id: 'tab.select', source: 'toolbar', args: { index: i } }), flashIndex);
await sleep(300);
await ui.evaluate(() => window.anne.execute({ id: 'legacy.flash', source: 'palette' }));
const movie = await until(() => flash!.evaluate(() => {
  const player = document.querySelector('ruffle-embed, ruffle-object, ruffle-player') as (HTMLElement & { metadata?: { width: number; height: number; swfVersion: number } | null }) | null;
  return player?.metadata ? `${player.metadata.width}x${player.metadata.height} v${player.metadata.swfVersion}` : undefined;
}), 20000);
check('Run Flash Content plays a movie through Ruffle', movie === '100x100 v6', String(movie));
check('emulator files stay unreachable from other tabs', !!other && (await other.evaluate(() => fetch('anne-ruffle://app/ruffle.js').then((r) => (r.ok ? 'loaded' : 'blocked'), () => 'blocked'))) === 'blocked');
check('the emulator gives the page no route to the browser', (await flash!.evaluate(() => typeof (window as unknown as Record<string, unknown>)['anne'] + typeof (window as unknown as Record<string, unknown>)['require'])) === 'undefinedundefined');

// ---- modal keyboard mode ----
await go(`${base}/typing`);
const typing = await tabWith('/typing');
// The page records the key-down events it is given.
await typing!.evaluate(() => {
  (window as unknown as { seen: string[] }).seen = [];
  addEventListener('keydown', (e) => (window as unknown as { seen: string[] }).seen.push(e.key), true);
});
const seen = () => typing!.evaluate(() => (window as unknown as { seen: string[] }).seen.join(''));
await ui.evaluate(() => window.anne.execute({ id: 'view.keymap', source: 'toolbar', args: { keymap: 'vi' } }));
await press(`${base}/typing`, 'X');
await sleep(300);
check('outside modal mode, plain keys reach the page', (await seen()).toLowerCase() === 'x', await seen());
await ui.evaluate(() => window.anne.execute({ id: 'input.modal-mode', source: 'toolbar' }));
await sleep(300);
await press(`${base}/typing`, 'X');
await press(`${base}/typing`, 'Q');
await sleep(300);
check('in modal mode, plain keys do not reach the page', (await seen()).toLowerCase() === 'x', await seen());
n = await countTabs();
await press(`${base}/typing`, 'T');
check('in modal mode, a single key runs its command', !!(await until(async () => (await countTabs()) === n + 1)));
await ui.evaluate(() => window.anne.execute({ id: 'input.modal-mode', source: 'toolbar' }));
await ui.evaluate(() => window.anne.execute({ id: 'view.keymap', source: 'toolbar', args: { keymap: 'default' } }));

await ui.evaluate(() => window.anne.execute({ id: 'tab.select', source: 'toolbar', args: { index: 1 } }));
await sleep(300);
await ui.evaluate(() => window.anne.execute({ id: 'view.page-source', source: 'toolbar' }));
const sources = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()).filter((u) => u.startsWith('view-source:')));
check('Page Source opens a view-source tab', !!(await until(async () => (await sources()).length === 1)), (await sources()).join());

check('address bar follows the page after focus returns to it', !!(await until(async () => (await uiState()).address.startsWith('view-source:'))), (await uiState()).address);
check('notices clear by themselves', !!(await until(async () => (await uiState()).notice === '', 9000)), (await uiState()).notice ?? '');
await phase3Checks();
await ui.screenshot({ path: join(root, 'dist/smoke-ui.png') }).catch(() => {});
await app.close();

// ---- profile data survives a restart ----
{
  // Point the saved search engine at the local test server, so the check makes no outside connection.
  const settingsFile = join(userData, 'profile', 'settings.json');
  const saved = JSON.parse(readFileSync(settingsFile, 'utf8'));
  saved.searchTemplate = `https://127.0.0.1:${httpsPort || 9}/search?q=%s`;
  writeFileSync(settingsFile, JSON.stringify(saved));
  const app3 = await launch({});
  const ui3 = await until(() => app3.windows().find((p) => p.url().startsWith('anne://chrome/')));
  // The home page chosen in the first run is used again.
  const home3 = await until(() => app3.windows().find((p) => p.url() === `${base}/links`));
  check('the saved home page opens at startup', !!home3);
  await ui3!.evaluate(() => window.anne.execute({ id: 'bookmark.show', source: 'toolbar' }));
  const kept = await until(async () => {
    const items = (await ui3!.evaluate(() => window.anne.list({ kind: 'bookmarks', query: '' }))) as { url: string }[];
    return items.length > 0 && items;
  });
  check('bookmarks are still there after a restart', !!kept && kept.some((b) => b.url === `${base}/find`), JSON.stringify(kept));
  await ui3!.evaluate(() => window.anne.closeOverlay());
  const started = app3.evaluate(({ webContents }, home) => new Promise<string>((resolve) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === home)!;
    wc.once('did-start-navigation', (d) => resolve(d.url));
    setTimeout(() => resolve('none'), 3000);
  }), `${base}/links`);
  await ui3!.evaluate(() => window.anne.execute({ id: 'nav.go', source: 'toolbar', args: { text: 'old browsers' } }));
  const searchedAt = await started;
  check('the saved search engine is read at startup and used by the address bar', searchedAt === `https://127.0.0.1:${httpsPort || 9}/search?q=old%20browsers`, searchedAt);
  await app3.close();
}

// ---- without the development switch, loopback gopher is refused ----
const app2 = await launch({ ANNE_DEV_GOPHER_PRIVATE: '' });
const ui2 = await until(() => app2.windows().find((p) => p.url().startsWith('anne://chrome/')));
gopherHits.length = 0;
await until(() => app2.windows().find((p) => p.url().startsWith('anne://pages/home')));
await ui2!.evaluate((t) => window.anne.execute({ id: 'nav.go', source: 'toolbar', args: { text: t } }), `gopher://127.0.0.1:${gopherPort}/`);
const refused = await until(() => app2.windows().find((p) => p.url().startsWith('gopher://')));
const body = refused ? await until(async () => (await refused.textContent('body')) || undefined) : '';
check('gopher to this computer is refused by default', !!body && body.includes('private network') && gopherHits.length === 0, String(body).slice(0, 80));
await app2.close();

http.close();
gopher.close();
https?.close();
console.log(failures === 0 ? '\nsmoke: all checks passed' : `\nsmoke: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);

// ======================================================================
// Phase 3: settings, find, bookmarks, history, private windows, downloads,
// permission prompts, page info, certificates, clearing data, context menus.
// ======================================================================
async function phase3Checks(): Promise<void> {
  const profile = join(userData, 'profile');
  const readProfile = (name: string) => { try { return JSON.parse(readFileSync(join(profile, name), 'utf8')); } catch { return undefined; } };
  const run = (id: string, args?: Record<string, string | number | boolean>) =>
    ui.evaluate((a) => window.anne.execute({ id: a.id, source: 'toolbar', ...(a.args && { args: a.args }) }), { id, args }) as Promise<{ ok: boolean; reason?: string }>;
  const list = (kind: string, query = '') =>
    ui.evaluate((a) => window.anne.list({ kind: a.kind as never, query: a.query }), { kind, query }) as Promise<{ id: number; title: string; url: string; detail: string }[]>;
  const findState = () => ui.evaluate(() => ({
    open: !document.getElementById('find')!.hidden,
    count: document.getElementById('find-count')!.textContent,
  }));

  // Native dialogs are replaced for the test: each records what it was asked and gives a scripted answer.
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as Record<string, unknown>;
    g['__dialogs'] = [];
    g['__answers'] = {} as Record<string, number>;
    const answer = (message: string) => {
      (g['__dialogs'] as string[]).push(message);
      const rules = g['__answers'] as Record<string, number>;
      const key = Object.keys(rules).find((k) => message.includes(k));
      return key === undefined ? 0 : rules[key]!;
    };
    const asText = (o: Electron.MessageBoxOptions) => `${o.message}\n${o.detail ?? ''}`;
    dialog.showMessageBox = (async (a: unknown, b?: unknown) => ({ response: answer(asText((b ?? a) as Electron.MessageBoxOptions)), checkboxChecked: false })) as never;
    dialog.showMessageBoxSync = ((a: unknown, b?: unknown) => answer(asText((b ?? a) as Electron.MessageBoxOptions))) as never;
  });
  const setAnswer = (key: string, response: number) => app.evaluate((_e, a) => {
    ((globalThis as unknown as Record<string, Record<string, number>>)['__answers']!)[a.key] = a.response;
  }, { key, response });
  const dialogs = () => app.evaluate(() => (globalThis as unknown as Record<string, string[]>)['__dialogs']!.slice());
  const clearDialogs = () => app.evaluate(() => { (globalThis as unknown as Record<string, string[]>)['__dialogs']!.length = 0; });

  // ---- settings ----
  await run('view.menu-layout', { layout: 'suite-1999' });
  check('choosing a layout saves it to the profile', !!(await until(() => readProfile('settings.json')?.layout === 'suite-1999')), JSON.stringify(readProfile('settings.json')));
  await run('tools.search-engine', { engine: 'wikipedia' });
  check('choosing a search engine saves it', readProfile('settings.json')?.searchTemplate === 'https://en.wikipedia.org/w/index.php?search=%s');
  const bad = await run('tools.search-engine', { engine: 'evil' });
  check('an unknown search engine is refused and nothing is saved', !bad.ok && readProfile('settings.json')?.searchTemplate.startsWith('https://en.wikipedia.org/'));
  await run('view.menu-layout', { layout: 'modern' });

  // ---- find in page ----
  await go(`${base}/find`);
  const findTab = await tabWith('/find');
  await until(async () => (await findTab?.title()) === 'find page');
  await run('edit.find');
  check('Find opens the find bar', !!(await until(async () => (await findState()).open)));
  await ui.locator('#find-input').fill('apple');
  check('typing in the find bar searches the page', !!(await until(async () => (await findState()).count === '1 of 3')), (await findState()).count ?? '');
  await run('edit.find-next');
  check('Find Next moves to the next match', !!(await until(async () => (await findState()).count === '2 of 3')), (await findState()).count ?? '');
  await run('edit.find-previous');
  check('Find Previous moves back', !!(await until(async () => (await findState()).count === '1 of 3')), (await findState()).count ?? '');
  await ui.locator('#find-input').fill('zebra');
  check('a missing word reports no matches', !!(await until(async () => (await findState()).count === 'No matches')));
  await run('edit.find-close');
  check('Close Find Bar hides it', !!(await until(async () => !(await findState()).open)));

  // ---- bookmarks ----
  await run('bookmark.toggle');
  const starred = () => ui.evaluate(() => document.getElementById('star')!.getAttribute('aria-pressed'));
  check('Bookmark This Page marks the page', !!(await until(async () => (await starred()) === 'true')));
  check('a panel cannot be read while it is closed', (await list('bookmarks')).length === 0);
  await run('bookmark.show');
  const marks = await until(async () => { const l = await list('bookmarks'); return l.length > 0 && l; });
  check('the bookmarks panel lists the page', !!marks && marks[0]!.url === `${base}/find` && marks[0]!.title === 'find page', JSON.stringify(marks));
  check('another panel cannot be read while this one is open', (await list('history')).length === 0);
  check('bookmarks are written to the profile', !!(await until(() => readProfile('bookmarks.json')?.entries?.[0]?.url === `${base}/find`)));
  await run('bookmark.show');

  // ---- history ----
  await run('history.show');
  const hist = await until(async () => { const l = await list('history'); return l.length > 0 && l; });
  check('history lists visited pages', !!hist && hist.some((h) => h.url === `${base}/a`) && hist.some((h) => h.url === `${base}/find`), JSON.stringify(hist?.map((h) => h.url)));
  check('history never lists internal pages', !!hist && !hist.some((h) => h.url.startsWith('anne:')));
  const filtered = await list('history', 'find page');
  check('history search filters by title', filtered.length === 1 && filtered[0]!.url === `${base}/find`, JSON.stringify(filtered.map((h) => h.url)));
  await run('history.remove', { id: filtered[0]!.id });
  check('a history entry can be deleted', !!(await until(async () => (await list('history', 'find page')).length === 0)));
  const typingEntry = (await list('history', 'typing'))[0];
  await run('history.open', { id: typingEntry!.id });
  check('opening a history entry closes the panel and loads the page', !!(await until(async () => (await uiState()).address === `${base}/typing` && !(await ui.evaluate(() => !document.getElementById('panel')!.hidden)))));

  // ---- private window ----
  await go(`${base}/a`);
  const normalTab = await tabWith(`${base}/a`);
  await normalTab!.evaluate(() => { document.cookie = 'who=normal; path=/'; });
  await run('app.new-private-window');
  check('New Private Window opens a second window', !!(await until(async () => (await windowCount()) === 2)));
  const pui = await until(() => app.windows().find((p) => p !== ui && p.url().startsWith('anne://chrome/')));
  check('the private window looks different', !!pui && !!(await until(() => pui.evaluate(() => document.body.classList.contains('private') && !document.getElementById('private-badge')!.hidden))));
  await pui!.evaluate((u) => window.anne.execute({ id: 'nav.go', source: 'toolbar', args: { text: u } }), `${base}/private-visit`);
  const ptab = await tabWith('/private-visit');
  check('private window shares no cookies with normal windows', !!ptab && (await ptab.evaluate(() => document.cookie)) === '');
  await ptab!.evaluate(() => { document.cookie = 'who=private; path=/'; });
  check('normal windows cannot see private cookies', (await normalTab!.evaluate(() => document.cookie)) === 'who=normal');
  await sleep(500);
  await run('history.show');
  check('private browsing is not added to history', (await list('history', 'private-visit')).length === 0);
  await run('history.show');
  const settingsBefore = JSON.stringify(readProfile('settings.json'));
  await pui!.evaluate(() => window.anne.execute({ id: 'view.menu-layout', source: 'toolbar', args: { layout: 'minimal-1994' } }));
  await sleep(300);
  check('a private window does not change saved settings', JSON.stringify(readProfile('settings.json')) === settingsBefore);
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.title.includes('Private'))?.close());
  check('the private window closes', !!(await until(async () => (await windowCount()) === 1)));
  await run('app.new-private-window');
  const pui2 = await until(() => app.windows().find((p) => p !== ui && p.url().startsWith('anne://chrome/')));
  await pui2!.evaluate((u) => window.anne.execute({ id: 'nav.go', source: 'toolbar', args: { text: u } }), `${base}/private-again`);
  const ptab2 = await tabWith('/private-again');
  check('a new private window starts with no cookies', !!ptab2 && (await ptab2.evaluate(() => document.cookie)) === '');
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.title.includes('Private'))?.close());
  await until(async () => (await windowCount()) === 1);

  // ---- downloads ----
  await clearDialogs();
  await go(`${base}/file.txt`);
  check('a download is saved', !!(await until(() => existsSync(join(downloadDir, 'notes.txt')))));
  await run('tools.downloads');
  const dl = await until(async () => { const l = await list('downloads'); return l.some((d) => d.detail.startsWith('Completed')) && l; });
  check('the downloads panel lists it as completed', !!dl && dl[0]!.title === 'notes.txt', JSON.stringify(dl));
  check('an ordinary download shows no warning', (await dialogs()).length === 0, (await dialogs()).join('|'));
  await go(`${base}/tool.exe`);
  await sleep(1500);
  check('a program file triggers a warning naming it', (await dialogs()).some((d) => d.includes('"tool.exe" can run programs')), (await dialogs()).join('|'));
  check('declining the warning saves nothing', !existsSync(join(downloadDir, 'tool.exe')) && !(await list('downloads')).some((d) => d.title === 'tool.exe'));
  await setAnswer('can run programs', 1);
  await go(`${base}/tool.exe`);
  check('accepting the warning saves the file', !!(await until(() => existsSync(join(downloadDir, 'tool.exe')))));
  const flagged = await until(async () => (await list('downloads')).find((d) => d.title === 'tool.exe' && d.detail.startsWith('Completed')));
  check('the panel marks it as able to run programs', !!flagged && flagged.detail.includes('can run programs'), flagged?.detail ?? '');
  await setAnswer('can run programs', 0);
  await run('tools.download-dismiss', { id: flagged!.id });
  check('a finished download can be removed from the list (file kept)', !!(await until(async () => !(await list('downloads')).some((d) => d.title === 'tool.exe'))) && existsSync(join(downloadDir, 'tool.exe')));
  await run('tools.downloads');

  // ---- permission prompts ----
  await clearDialogs();
  await setAnswer('wants to show notifications', 1);
  await go(`${base}/perm`);
  const perm = await tabWith('/perm');
  await until(async () => !!perm && perm.frames().some((f) => f.url().includes('/inner')));
  const first = await perm!.evaluate(() => Notification.requestPermission());
  const asked = await dialogs();
  check('a permission request shows a prompt naming the site', first === 'granted' && asked.some((d) => d.startsWith(`${base} wants to show notifications.`)), `${first} ${asked.join('|')}`);
  await clearDialogs();
  const second = await perm!.evaluate(() => Notification.requestPermission());
  check('the answer is remembered for the site', second === 'granted' && (await dialogs()).length === 0);
  const inner = perm!.frames().find((f) => f.url().includes('/inner'));
  const framed = await inner!.evaluate(() => Notification.requestPermission());
  check('an embedded frame from another site cannot ask', framed !== 'granted' && (await dialogs()).length === 0, `${framed} ${(await dialogs()).join('|')}`);
  await setAnswer('wants to show notifications', 0);
  await go(`http://localhost:${httpPort}/a`);
  const other = await tabWith(`http://localhost:${httpPort}/a`);
  const blocked = await other!.evaluate(() => Notification.requestPermission());
  check('choosing Block refuses the permission', blocked === 'denied', blocked);

  // ---- page info ----
  await go(`${base}/perm`);
  await until(async () => (await uiState()).address === `${base}/perm`);
  await clearDialogs();
  await run('page.info');
  const info = (await until(async () => (await dialogs()).find((d) => d.includes('Address:')))) ?? '';
  check('Page Info shows the address and an unencrypted warning', info.includes(`Address: ${base}/perm`) && info.includes('NOT encrypted'), info);
  check('Page Info lists permissions granted this session', info.includes('Permissions allowed this session: show notifications'), info);
  check('Page Info counts the cookies the page can read', info.includes('Cookies this page can read: 1'), info);

  // ---- certificates ----
  if (httpsPort) {
    await go(`https://127.0.0.1:${httpsPort}/`);
    await sleep(1500);
    const secret = tabs().find((p) => p.url().startsWith(`https://127.0.0.1:${httpsPort}`));
    const shown = secret ? await secret.title().catch(() => '') : '';
    check('a self-signed certificate is still rejected', shown !== 'secret' && !!(await until(async () => (await uiState()).notice?.includes('CERT'))), `${shown} ${(await uiState()).notice}`);
  }

  // ---- clear browsing data ----
  await setAnswer('Clear browsing data?', 2);
  await run('privacy.clear-data');
  await sleep(800);
  await run('history.show');
  check('Clear Browsing Data empties history', (await list('history')).length === 0);
  await run('history.show');
  await go(`${base}/a`);
  const after = await tabWith(`${base}/a`);
  await until(async () => (await uiState()).address === `${base}/a`);
  check('Clear Browsing Data removes cookies', (await after!.evaluate(() => document.cookie)) === '');
  await clearDialogs();
  await go(`${base}/perm`);
  await until(async () => (await uiState()).address === `${base}/perm`);
  await run('page.info');
  const info2 = (await until(async () => (await dialogs()).find((d) => d.includes('Address:')))) ?? '';
  check('Clear Browsing Data forgets permission answers', info2.includes('Permissions allowed this session: none'), info2);
  await run('bookmark.show');
  check('Clear Browsing Data keeps bookmarks', (await list('bookmarks')).length === 1);
  await run('bookmark.show');

  // ---- context menus ----
  await app.evaluate(({ Menu }) => {
    (Menu.prototype as unknown as { popup: () => void }).popup = function (this: Electron.Menu) {
      (globalThis as unknown as Record<string, Electron.Menu>)['__ctxMenu'] = this;
    };
  });
  const lastMenu = () => app.evaluate(() => (globalThis as unknown as Record<string, Electron.Menu | undefined>)['__ctxMenu']?.items.map((i) => i.label) ?? []);
  const rightClick = async (selector: string) => {
    await app.evaluate(() => { delete (globalThis as unknown as Record<string, unknown>)['__ctxMenu']; });
    const box = await (await tabWith('/links'))!.evaluate((sel) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      return { x: Math.round(r.left + 10), y: Math.round(r.top + r.height / 2) };
    }, selector);
    await app.evaluate(({ webContents }, b) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/links'))!;
      wc.sendInputEvent({ type: 'mouseDown', x: b.x, y: b.y, button: 'right', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'right', clickCount: 1 });
    }, box);
    return until(async () => { const l = await lastMenu(); return l.length > 0 && l; });
  };
  await go(`${base}/links`);
  await tabWith('/links');
  await until(async () => (await uiState()).address === `${base}/links`);
  const linkMenu = await rightClick('#good');
  check('right-clicking a link offers link commands', !!linkMenu && linkMenu.includes('Open Link in New Tab') && linkMenu.includes('Copy Link Address'), JSON.stringify(linkMenu));
  const before = tabs().length;
  await app.evaluate(() => {
    const menu = (globalThis as unknown as Record<string, Electron.Menu>)['__ctxMenu']!;
    const item = menu.items.find((i) => i.label === 'Open Link in New Tab')!;
    (item.click as unknown as () => void)();
  });
  check('Open Link in New Tab opens it', !!(await until(() => tabs().length === before + 1 && tabs().some((p) => p.url() === `${base}/linked`))));
  await ui.evaluate(() => window.anne.execute({ id: 'tab.previous', source: 'toolbar' }));
  await until(async () => (await uiState()).address === `${base}/links`);
  const badMenu = await rightClick('#bad');
  check('a javascript: link gets no link commands', !!badMenu && !badMenu.includes('Open Link in New Tab'), JSON.stringify(badMenu));
  const tabsBeforeForgery = (await uiState()).tabs;
  await run('tab.open-link', { url: 'file:///etc/passwd' });
  await sleep(500);
  check('Open Link cannot be used to reach local files', !tabs().some((p) => p.url().startsWith('file:')), tabs().map((p) => p.url()).join());
  check('a refused link leaves no empty tab behind', (await uiState()).tabs === tabsBeforeForgery, `${(await uiState()).tabs} vs ${tabsBeforeForgery}`);
  check('the refusal is explained', !!(await until(async () => (await uiState()).notice?.startsWith('Blocked'))), (await uiState()).notice ?? '');

  // ---- save page ----
  await app.evaluate(({ dialog }, dir) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: `${dir}/saved-page.html` })) as never;
  }, downloadDir);
  await run('file.save-page-as');
  check('Save Page As writes the page', !!(await until(() => existsSync(join(downloadDir, 'saved-page.html')) && readFileSync(join(downloadDir, 'saved-page.html'), 'utf8').includes('good link'))));

  // ---- census: history pages and palette ranking ----
  await run('help.menu-archaeology');
  const arch = await tabWith('anne://pages/archaeology');
  const archText = (await until(async () => { const t = await arch?.textContent('body'); return t?.includes('Menu archaeology') ? t : undefined; })) ?? '';
  check('Menu Archaeology shows histories read from source code', archText.includes('Google Chrome 3.0.195.25 (2009)') && archText.includes('have a history read from browser source code'), archText.slice(0, 120));
  check('Menu Archaeology links each command to its page', !!(await arch?.$('a[href="anne://pages/command?id=tab.new"]')));
  await go('anne://pages/command?id=tab.new');
  const cmdPage = await until(() => tabs().find((p) => p.url() === 'anne://pages/command?id=tab.new'));
  const hrefs = cmdPage ? await cmdPage.$$eval('a', (as) => as.map((x) => x.getAttribute('href') ?? '')) : [];
  check('a command page links to the exact source line', hrefs.some((h) => /^https:\/\/github\.com\/chromium\/chromium\/blob\/[0-9a-f]{12}\/chrome\/app\/chrome_dll_resource\.h#L\d+$/.test(h)), hrefs.slice(0, 3).join(' '));
  // tab.new also has two entries written from memory in the seed catalog; they must be marked.
  const unverifiedTags = (page: import('playwright-core').Page) => page.$$eval('.tag', (els) => els.filter((e) => e.textContent === 'unverified').length);
  check('a command page marks lineage written from memory as unverified', !!cmdPage && (await unverifiedTags(cmdPage)) === 2, String(cmdPage ? await unverifiedTags(cmdPage) : 'no page'));
  await go('anne://pages/command?id=view.scroll-top');
  const sourcedOnly = await until(() => tabs().find((p) => p.url() === 'anne://pages/command?id=view.scroll-top'));
  check('a command whose history is all read from source has nothing marked unverified', !!sourcedOnly && (await unverifiedTags(sourcedOnly)) === 0 && (await sourcedOnly.textContent('body'))!.includes('Lynx'));
  await go('anne://pages/command?id=%3Cscript%3E');
  const nf = await until(() => tabs().find((p) => p.url().includes('id=%3Cscript%3E')));
  check('an unknown command id gives a plain not-found page', !!nf && (await nf.textContent('body'))!.includes('Not found'));
  await ui.evaluate(() => window.anne.execute({ id: 'app.command-palette', source: 'toolbar' }));
  await until(() => ui.evaluate(() => !document.getElementById('palette')!.hidden));
  await ui.locator('#palette-input').fill('scroll to top');
  const planned = await until(() => ui.evaluate(() => [...document.querySelectorAll('#palette-list li')].some((li) => li.querySelector('.planned') && li.textContent!.includes('Scroll to Top'))));
  check('the palette finds catalogued commands and marks the unbuilt ones as planned', !!planned);
  await ui.locator('#palette-input').fill('new tab');
  const firstHit = await until(() => ui.evaluate(() => { const li = document.querySelector('#palette-list li'); return li ? { text: li.textContent, planned: !!li.querySelector('.planned') } : undefined; }));
  check('built commands rank first', !!firstHit && !firstHit.planned && firstHit.text!.startsWith('New Tab'), JSON.stringify(firstHit));
  await ui.evaluate(() => window.anne.closeOverlay());

  // ---- home page ----
  await go(`${base}/links`);
  await until(async () => (await uiState()).address === `${base}/links`);
  await run('nav.set-home-page');
  check('Use Current Page as Home Page saves it', !!(await until(() => readProfile('settings.json')?.homePage === `${base}/links`)));
  const homeBefore = tabs().length;
  await run('tab.new');
  check('new tabs open the home page', !!(await until(() => tabs().length === homeBefore + 1 && tabs().filter((p) => p.url() === `${base}/links`).length >= 2)));
}
