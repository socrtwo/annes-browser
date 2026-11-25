import { describe, expect, it } from 'vitest';
import { evaluateWhen, parseWhen, whenKeys, WhenSyntaxError } from '../app/core/when/when.ts';

const ev = (src: string, ctx: Record<string, string | number | boolean> = {}) => evaluateWhen(parseWhen(src), ctx);

describe('when expressions', () => {
  it('evaluates keys, literals and operators', () => {
    expect(ev('tab.canGoBack', { 'tab.canGoBack': true })).toBe(true);
    expect(ev('!tab.canGoBack', { 'tab.canGoBack': true })).toBe(false);
    expect(ev("page.scheme == 'https' || page.scheme == \"http\"", { 'page.scheme': 'http' })).toBe(true);
    expect(ev('tab.count > 1 && !(ui.paletteOpen)', { 'tab.count': 2, 'ui.paletteOpen': false })).toBe(true);
    expect(ev('page.zoom <= 0.25', { 'page.zoom': 0.25 })).toBe(true);
    expect(ev('a || b && c', { a: true, b: false, c: false })).toBe(true);
  });

  it('treats unknown keys as false, so a typo disables instead of enables', () => {
    expect(ev('tab.canGoBakc')).toBe(false);
    expect(ev('missing > 1')).toBe(false);
    expect(ev("missing != 'x'")).toBe(true);
  });

  it('never reads inherited properties', () => {
    expect(ev('constructor')).toBe(false);
    expect(ev('toString')).toBe(false);
    expect(ev('__proto__')).toBe(false);
  });

  it('rejects malformed input', () => {
    for (const bad of ['', '&&', 'a &&', '(a', 'a b', "a == 'x", 'a = b', 'a.b.', 'f(x)', 'a[0]', 'a;b', '${a}']) {
      expect(() => parseWhen(bad), bad).toThrow(WhenSyntaxError);
    }
    expect(() => parseWhen('('.repeat(100) + 'a' + ')'.repeat(100))).toThrow(/nested/);
    expect(() => parseWhen('a'.repeat(600))).toThrow(/too long/);
  });

  it('lists the keys an expression reads', () => {
    expect([...whenKeys(parseWhen('a.b && !(c == 1) || d'))].sort()).toEqual(['a.b', 'c', 'd']);
  });
});
