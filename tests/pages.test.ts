import { describe, expect, it } from 'vitest';
import type { CommandRecord } from '../app/core/catalog/types.ts';
import { archaeologyPage, commandPage, lineageSummary, refUrl, stubPage } from '../app/core/pages.ts';

const cmd = (extra: Partial<CommandRecord> = {}): CommandRecord => ({
  id: 'tab.new', label: 'New Tab', category: 'tab', description: 'Open a new tab.', status: 'implement', phase: 2, platforms: ['desktop'], ...extra,
});

describe('census references', () => {
  it('turns a ref into a GitHub address', () => {
    expect(refUrl('chromium/chromium@05197078e476:chrome/app/chrome_dll_resource.h#L65')).toBe(
      'https://github.com/chromium/chromium/blob/05197078e476/chrome/app/chrome_dll_resource.h#L65');
    expect(refUrl('o/r@abcdef1:a b/c.xul#L3')).toBe('https://github.com/o/r/blob/abcdef1/a%20b/c.xul#L3');
  });

  it('links a manual reference to the scanned text at the Internet Archive, and nowhere else', () => {
    expect(refUrl('archive.org/mac_Netscape_gator_v_1.1_1995/Netscape_gator_v_1.1_1995_djvu.txt#L2078')).toBe(
      'https://archive.org/stream/mac_Netscape_gator_v_1.1_1995/Netscape_gator_v_1.1_1995_djvu.txt');
    for (const bad of ['archive.org/item/evil.exe#L1', 'archive.org/../x_djvu.txt#L1', 'archive.org.evil.example/item/x_djvu.txt#L1', 'archive.org/item/x_djvu.txt']) {
      expect(refUrl(bad), bad).toBeUndefined();
    }
  });

  it('refuses anything that is not in that form, so a ref cannot become another kind of link', () => {
    for (const bad of ['javascript:alert(1)', 'https://evil.example/', 'o/r@abc:x#L1', 'o/r@abcdef1:../../x#L1x', 'o/r@abcdef1:x', '', 'o/r@abcdef1:a"b#L1']) {
      expect(refUrl(bad), bad).toBeUndefined();
    }
  });
});

describe('lineage summary', () => {
  it('groups versions by browser and marks unverified ones', () => {
    expect(lineageSummary([
      { browser: 'Google Chrome', versions: '3.0.195.25', year: 2009, source: 'census' },
      { browser: 'Google Chrome', versions: '10.0.648.204', year: 2011, source: 'census' },
      { browser: 'Lynx', versions: 'development snapshot', year: 2026, source: 'census' },
      { browser: 'Safari', versions: '2.0', year: 2005, source: 'recalled' },
    ])).toBe('Google Chrome 3.0.195.25 (2009), 10.0.648.204 (2011); Lynx now (2026); Safari 2.0 (2005) unverified');
  });
});

describe('command pages', () => {
  const hostile = '<script>alert(1)</script>"\'&';
  const c = cmd({
    label: hostile, description: hostile, aliases: [hostile], status_reason: hostile,
    lineage: [
      { browser: hostile, versions: hostile, menu: hostile, year: 2000, source: 'census', key: hostile, ref: 'o/r@abcdef1:f.c#L9' },
      { browser: 'Opera', source: 'recalled' },
    ],
  });

  it('escapes everything that comes from the catalog', () => {
    for (const html of [commandPage(c), stubPage(c), archaeologyPage([c])]) {
      expect(html).not.toMatch(/<script>alert/);
      expect(html).toContain('&#60;script&#62;');
    }
  });

  it('links census entries to their source line and marks recalled ones', () => {
    const html = commandPage(c);
    expect(html).toContain('href="https://github.com/o/r/blob/abcdef1/f.c#L9"');
    expect(html).toContain('unverified');
  });

  it('links each archaeology row to its command page, with the id encoded', () => {
    expect(archaeologyPage([cmd({ id: 'tab.new' })])).toContain('href="anne://pages/command?id=tab.new"');
  });

  it('handles an unknown command and one with no history', () => {
    expect(commandPage(undefined)).toContain('Not found');
    expect(commandPage(cmd())).toContain('No history recorded yet');
  });
});
