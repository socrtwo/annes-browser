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

// ---- launch ----
const launch = (env: Record<string, string>) => _electron.launch({
  executablePath: require('electron') as unknown as string,
  // --no-sandbox only because CI containers run as root; the app itself enables the sandbox.
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), root],
  env: { ...process.env, ...env } as Record<string, string>,
});
const app = await launch({ ANNE_DEV_GOPHER_PRIVATE: '1' });
const pages = () => app.windows();
const ui = await until(() => pages().find((p) => p.url().startsWith('anne://chrome/')));
check('UI loads from anne://chrome', !!ui);
if (!ui) { await app.close(); process.exit(1); }
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
check('UI bridge exposes exactly four functions', uiProbe.api === 'execute,onState,paletteClose,paletteSearch', uiProbe.api);
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
await ui.screenshot({ path: join(root, 'dist/smoke-ui.png') }).catch(() => {});
await app.close();

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
console.log(failures === 0 ? '\nsmoke: all checks passed' : `\nsmoke: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
