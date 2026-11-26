import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS, isValidHomePage, isValidSearchTemplate, parseSettings, SettingsError, SettingsStore,
} from '../app/core/data/settings.ts';
import { readJson, writeJsonAtomic } from '../app/core/data/storage.ts';
import { isStorableUrl, UrlStore } from '../app/core/data/url-store.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anne-test-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const known = { layouts: ['modern', 'suite-1999'], keymaps: ['default', 'vi'] };

describe('storage', () => {
  it('writes atomically and reads back', () => {
    const p = join(dir, 'sub', 'x.json');
    writeJsonAtomic(p, { a: 1 });
    expect(readJson(p)).toEqual({ kind: 'ok', value: { a: 1 } });
    expect(readdirSync(join(dir, 'sub'))).toEqual(['x.json']);
  });

  it('reports missing files and moves corrupt ones aside', () => {
    expect(readJson(join(dir, 'none.json'))).toEqual({ kind: 'missing' });
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{"a":');
    const r = readJson(p);
    expect(r.kind).toBe('corrupt');
    expect(readdirSync(dir).some((f) => f.startsWith('bad.json.corrupt-'))).toBe(true);
    expect(readdirSync(dir)).not.toContain('bad.json');
  });
});

describe('settings', () => {
  it('validates home pages', () => {
    for (const ok of ['https://example.com/', 'http://localhost:8080/', 'gopher://g.example/', 'file:///home/a/x.html', 'anne://pages/home']) {
      expect(isValidHomePage(ok), ok).toBe(true);
    }
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'anne://chrome/index.html', 'https://u:p@example.com/', 'not a url', 42, `https://e.com/${'a'.repeat(3000)}`]) {
      expect(isValidHomePage(bad), String(bad)).toBe(false);
    }
  });

  it('validates search templates', () => {
    expect(isValidSearchTemplate('https://s.example/?q=%s')).toBe(true);
    for (const bad of ['http://s.example/?q=%s', 'https://s.example/?q=', 'https://s.example/?q=%s&r=%s', 'javascript:%s', 'https://u:p@s.example/?q=%s']) {
      expect(isValidSearchTemplate(bad), bad).toBe(false);
    }
  });

  it('drops unknown keys and resets invalid values to defaults', () => {
    const { settings, rejected } = parseSettings({ layout: 'suite-1999', keymap: 'nope', homePage: 'javascript:x', extra: 1, version: 99 }, known);
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, layout: 'suite-1999' });
    expect(rejected.sort()).toEqual(['homePage', 'keymap']);
    expect(parseSettings([1, 2], known).settings).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(undefined, known).rejected).toEqual([]);
  });

  it('persists updates and refuses invalid ones without changing anything', () => {
    const p = join(dir, 'settings.json');
    const store = new SettingsStore(p, known);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    store.update({ layout: 'suite-1999', homePage: 'https://example.com/' });
    expect(new SettingsStore(p, known).get()).toMatchObject({ layout: 'suite-1999', homePage: 'https://example.com/' });
    expect(() => store.update({ layout: 'suite-1999', keymap: 'bogus' })).toThrow(SettingsError);
    expect(store.get().keymap).toBe('default');
    expect(JSON.parse(readFileSync(p, 'utf8')).keymap).toBe('default');
  });

  it('survives a corrupt file and reports it', () => {
    const p = join(dir, 'settings.json');
    writeFileSync(p, 'not json');
    const store = new SettingsStore(p, known);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(store.loadProblems[0]).toMatch(/unreadable/);
  });
});

describe('url store', () => {
  it('stores only ordinary page URLs', () => {
    for (const ok of ['https://a.example/', 'http://a.example/x', 'gopher://g.example/1/', 'file:///x.html']) expect(isStorableUrl(ok), ok).toBe(true);
    for (const bad of ['anne://pages/home', 'view-source:https://a.example/', 'javascript:1', 'data:text/html,x', 'about:blank', 'https://u:p@a.example/', 'nope']) {
      expect(isStorableUrl(bad), bad).toBe(false);
    }
  });

  it('records visits newest first, counts them, and searches', () => {
    const s = new UrlStore({ cap: 10 });
    s.visit('https://a.example/', 'Alpha', 1);
    s.visit('https://b.example/', 'Beta page', 2);
    s.visit('https://a.example/', '', 3);
    expect(s.search('').map((e) => [e.url, e.title, e.count])).toEqual([
      ['https://a.example/', 'Alpha', 2], ['https://b.example/', 'Beta page', 1],
    ]);
    expect(s.search('beta').map((e) => e.url)).toEqual(['https://b.example/']);
    expect(s.search('page b.example').length).toBe(1);
    expect(s.search('alpha beta').length).toBe(0);
    expect(s.visit('anne://pages/home', 'x', 4)).toBe(false);
  });

  it('caps size by dropping the oldest', () => {
    const s = new UrlStore({ cap: 3 });
    for (let i = 0; i < 5; i++) s.visit(`https://e${i}.example/`, '', i);
    expect(s.search('').map((e) => e.url)).toEqual(['https://e4.example/', 'https://e3.example/', 'https://e2.example/']);
  });

  it('cleans titles and falls back to the URL', () => {
    const s = new UrlStore({ cap: 3 });
    s.add('https://a.example/', 'Line\none\u0000', 1);
    s.add('https://b.example/', '   ', 1);
    expect(s.search('').map((e) => e.title).sort()).toEqual(['Line one', 'https://b.example/']);
  });

  it('adds once, removes by id and url, clears, and notifies', () => {
    const s = new UrlStore({ cap: 5 });
    let n = 0;
    s.onDidChange(() => n++);
    s.add('https://a.example/', 'A', 1);
    s.add('https://a.example/', 'A again', 2);
    expect(s.size).toBe(1);
    const id = s.search('')[0]!.id;
    expect(s.get(id)?.title).toBe('A');
    expect(s.remove(id)).toBe(true);
    expect(s.remove(id)).toBe(false);
    s.add('https://b.example/', 'B', 1);
    expect(s.removeUrl('https://b.example/')).toBe(true);
    s.add('https://c.example/', 'C', 1);
    s.clear();
    expect(s.size).toBe(0);
    expect(n).toBe(6);
  });

  it('persists and reloads, dropping invalid entries', () => {
    const p = join(dir, 'history.json');
    const s = new UrlStore({ cap: 5, path: p, writeDelayMs: 10 });
    s.visit('https://a.example/', 'A', 5);
    s.flush();
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    raw.entries.push({ url: 'javascript:alert(1)', title: 'x', time: 1, count: 1 }, { url: 'https://a.example/', title: 'dup' }, 'junk', { url: 'https://b.example/', time: 'x', count: -4 });
    writeFileSync(p, JSON.stringify(raw));
    const t = new UrlStore({ cap: 5, path: p });
    expect(t.search('').map((e) => [e.url, e.time, e.count])).toEqual([['https://a.example/', 5, 1], ['https://b.example/', 0, 1]]);
    expect(t.loadProblems[0]).toMatch(/3 invalid entries/);
  });
});

describe('settings error type', () => {
  it('is an Error', () => expect(new SettingsError('x')).toBeInstanceOf(Error));
});
