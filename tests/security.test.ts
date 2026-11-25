import { describe, expect, it, vi } from 'vitest';
import { isDangerousFile, sanitizeFilename } from '../app/core/security/downloads.ts';
import { isPublicAddress, isRestrictedPort } from '../app/core/security/net-policy.ts';
import { PermissionPolicy, permissionRule } from '../app/core/security/permissions.ts';
import { hasUnsafeSwitches } from '../app/core/security/startup.ts';
import {
  decideFrameNavigation, decideNavigation, displayUrl, interpretAddressInput, searchUrl,
} from '../app/core/security/url-policy.ts';

const nav = (url: string, initiator: 'user-typed' | 'user-command' | 'web-content' | 'internal', from?: string) =>
  decideNavigation({ url, initiator, ...(from !== undefined && { from }) }).action;

describe('navigation policy', () => {
  it('allows web and gopher pages for everyone', () => {
    for (const who of ['user-typed', 'web-content'] as const) {
      expect(nav('https://example.com/', who)).toBe('allow');
      expect(nav('http://example.com/', who)).toBe('allow');
      expect(nav('gopher://gopher.floodgap.com/1/', who)).toBe('allow');
    }
  });

  it('keeps web content away from local files and internal pages', () => {
    expect(nav('file:///etc/passwd', 'web-content', 'https://evil.example/')).toBe('deny');
    expect(nav('file:///etc/passwd', 'web-content')).toBe('deny');
    expect(nav('file:///home/a/b.html', 'web-content', 'file:///home/a/a.html')).toBe('allow');
    expect(nav('file:///home/a/a.html', 'user-command')).toBe('allow');
    expect(nav('anne://pages/about', 'web-content', 'https://evil.example/')).toBe('deny');
    expect(nav('anne://pages/about', 'web-content', 'gopher://evil.example/')).toBe('deny');
    expect(nav('anne://pages/about', 'internal')).toBe('allow');
    expect(nav('anne://pages/stub?id=x', 'web-content', 'anne://pages/archaeology')).toBe('allow');
  });

  it('never navigates to browser UI, whoever asks', () => {
    for (const who of ['user-typed', 'user-command', 'web-content', 'internal'] as const) {
      expect(nav('anne://chrome/index.html', who)).toBe('deny');
      expect(nav('ANNE://CHROME/index.html', who)).toBe('deny');
    }
  });

  it('refuses script and data URLs from every source', () => {
    for (const who of ['user-typed', 'user-command', 'web-content', 'internal'] as const) {
      expect(nav('javascript:alert(1)', who)).toBe('deny');
      expect(nav('JaVaScRiPt:alert(1)', who)).toBe('deny');
      expect(nav('vbscript:x', who)).toBe('deny');
      expect(nav('data:text/html,<script>alert(1)</script>', who)).toBe('deny');
    }
  });

  it('routes other schemes: external apps, legacy commands, or denial', () => {
    expect(decideNavigation({ url: 'mailto:a@example.com', initiator: 'web-content' })).toMatchObject({ action: 'external', scheme: 'mailto' });
    expect(decideNavigation({ url: 'ftp://ftp.example.com/pub/', initiator: 'user-typed' })).toMatchObject({ action: 'command', command: 'legacy.ftp-open' });
    for (const url of ['ms-msdt:/id', 'smb://host/share', 'chrome://settings', 'devtools://devtools/x', 'search-ms:query', 'jar:file:///x!/y', 'ws://example.com/', 'filesystem:https://a/b', 'not a url', '']) {
      expect(nav(url, 'web-content'), url).toBe('deny');
      expect(nav(url, 'user-typed'), url).toBe('deny');
    }
  });

  it('limits view-source and about', () => {
    expect(nav('view-source:https://example.com/', 'user-command')).toBe('allow');
    expect(nav('view-source:https://example.com/', 'web-content')).toBe('deny');
    expect(nav('view-source:javascript:alert(1)', 'user-command')).toBe('deny');
    expect(nav('view-source:anne://chrome/index.html', 'user-command')).toBe('deny');
    expect(nav('about:blank', 'web-content')).toBe('allow');
    expect(nav('about:config', 'user-typed')).toBe('deny');
  });

  it('restricts frames to web content', () => {
    expect(decideFrameNavigation('https://ads.example/', 'https://example.com/').action).toBe('allow');
    expect(decideFrameNavigation('about:blank', 'https://example.com/').action).toBe('allow');
    for (const url of ['file:///etc/passwd', 'anne://pages/about', 'anne://chrome/index.html', 'gopher://x.example/', 'mailto:a@b.c', 'javascript:1']) {
      expect(decideFrameNavigation(url, 'https://example.com/').action, url).toBe('deny');
    }
    expect(decideFrameNavigation('file:///a/b.html', 'file:///a/a.html').action).toBe('allow');
  });
});

describe('address bar input', () => {
  const url = (text: string) => { const r = interpretAddressInput(text); return r.kind === 'url' ? r.url : r.kind; };

  it('recognizes addresses', () => {
    expect(url('example.com')).toBe('https://example.com');
    expect(url('  example.com/path?q=1  ')).toBe('https://example.com/path?q=1');
    expect(url('example.com:8443/x')).toBe('https://example.com:8443/x');
    expect(url('localhost:8080')).toBe('http://localhost:8080');
    expect(url('192.168.1.1')).toBe('http://192.168.1.1');
    expect(url('[::1]:3000/x')).toBe('http://[::1]:3000/x');
    expect(url('https://example.com/a b')).toBe('search');
    expect(url('gopher://gopher.floodgap.com')).toBe('gopher://gopher.floodgap.com');
    expect(url('about:blank')).toBe('about:blank');
    expect(url('mailto:a@example.com')).toBe('mailto:a@example.com');
  });

  it('treats everything else as a search', () => {
    for (const text of ['hello world', 'what is 3.14', '3.14', 'e.g', 'foo:bar', 'node.js tutorial', 'c++', '-.com', 'define:word']) {
      expect(url(text), text).toBe('search');
    }
    expect(url('   ')).toBe('empty');
  });

  it('strips control characters from pasted text', () => {
    expect(url('exam\nple.com')).toBe('https://example.com');
    expect(url('java\tscript:alert(1)')).toBe('javascript:alert(1)');
    expect(decideNavigation({ url: 'javascript:alert(1)', initiator: 'user-typed' }).action).toBe('deny');
  });

  it('builds search URLs and hides credentials in displayed URLs', () => {
    expect(searchUrl('https://s.example/?q=%s', 'a&b c')).toBe('https://s.example/?q=a%26b%20c');
    expect(displayUrl('https://bank.example:pw@evil.example/login')).toBe('https://evil.example/login');
    expect(displayUrl('https://аpple.com/')).toBe('https://xn--pple-43d.com/');
  });
});

describe('network destination policy', () => {
  it('accepts only globally routable literal addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254',
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', 'localhost', 'example.com', '', '1.2.3',
    ]) expect(isPublicAddress(ip), ip).toBe(false);
  });

  it('refuses ports that carry other protocols', () => {
    for (const p of [70, 7070, 8080, 443, 80]) expect(isRestrictedPort(p), String(p)).toBe(false);
    for (const p of [25, 22, 6379, 11211, 3306, 0, 65536, 1.5, NaN]) expect(isRestrictedPort(p), String(p)).toBe(true);
  });
});

describe('downloads', () => {
  it('makes server-supplied names safe', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Windows\\system32\\evil.dll')).toBe('evil.dll');
    expect(sanitizeFilename('.bashrc')).toBe('bashrc');
    expect(sanitizeFilename('a\u0000b\n.txt')).toBe('ab.txt');
    expect(sanitizeFilename('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeFilename('con.txt')).toBe('download');
    expect(sanitizeFilename('NUL')).toBe('download');
    expect(sanitizeFilename('...')).toBe('download');
    expect(sanitizeFilename('')).toBe('download');
    expect(sanitizeFilename('report. ')).toBe('report');
    expect(sanitizeFilename('a<b>:c|d?.txt')).toBe('a_b__c_d_.txt');
    const long = sanitizeFilename('x'.repeat(500) + '.pdf');
    expect(long.length).toBe(200);
    expect(long.endsWith('.pdf')).toBe(true);
  });

  it('flags files that run code', () => {
    for (const n of ['a.exe', 'A.EXE', 'x.pdf.scr', 'run.sh', 'm.docm', 'x.lnk']) expect(isDangerousFile(n), n).toBe(true);
    for (const n of ['a.pdf', 'a.txt', 'photo.jpg', 'noext']) expect(isDangerousFile(n), n).toBe(false);
  });
});

describe('permission policy', () => {
  it('denies by default, including unknown permissions and hardware access', () => {
    for (const p of ['usb', 'serial', 'hid', 'midiSysex', 'openExternal', 'something-new', 'constructor', '__proto__']) {
      expect(permissionRule(p), p).toBe('deny');
    }
  });

  it('denies "ask" permissions when no prompt is connected', async () => {
    const policy = new PermissionPolicy();
    expect(await policy.request('https://example.com', 'geolocation')).toBe(false);
    expect(policy.check('https://example.com', 'geolocation')).toBe(false);
    expect(await policy.request('https://example.com', 'fullscreen')).toBe(true);
  });

  it('asks once per origin and only for secure origins', async () => {
    const prompt = vi.fn(async (origin: string) => origin === 'https://good.example');
    const policy = new PermissionPolicy(prompt);
    expect(await policy.request('https://good.example/page', 'media')).toBe(true);
    expect(await policy.request('https://good.example/other', 'media')).toBe(true);
    expect(policy.check('https://good.example', 'media')).toBe(true);
    expect(await policy.request('https://bad.example', 'media')).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(2);
    for (const origin of ['http://example.com', 'gopher://example.com', 'file:///x', 'anne://pages', 'not a url']) {
      expect(await policy.request(origin, 'media'), origin).toBe(false);
    }
    expect(await policy.request('https://good.example', 'usb')).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(2);
    policy.forget('https://good.example');
    expect(policy.check('https://good.example', 'media')).toBe(false);
  });
});

describe('startup switches', () => {
  it('flags switches that weaken a release build', () => {
    for (const flag of ['--remote-debugging-port=9222', '--inspect', '--inspect-brk=0', '--no-sandbox', '--disable-web-security', '--ignore-certificate-errors', '--proxy-server=evil:8080', '--host-rules=MAP * evil', '--load-extension=/tmp/x', '--js-flags=--expose-gc']) {
      expect(hasUnsafeSwitches(['app', flag]), flag).toBe(flag);
    }
    expect(hasUnsafeSwitches(['app', 'https://example.com/?--no-sandbox', '--lang=en', '--inspector-thing'])).toBeUndefined();
  });
});
