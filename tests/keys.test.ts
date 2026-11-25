import { describe, expect, it } from 'vitest';
import type { Keymap } from '../app/core/catalog/types.ts';
import { chordFromInput, isTypingChord, parseSequence, toAccelerator } from '../app/core/keys/chord.ts';
import { displayBinding, findConflicts, KeyDispatcher, resolveKeymap } from '../app/core/keys/resolver.ts';

const input = (key: string, mods: Partial<Record<'control' | 'alt' | 'shift' | 'meta', boolean>> = {}) =>
  ({ key, control: false, alt: false, shift: false, meta: false, ...mods });

describe('chords', () => {
  it('normalizes modifier order, aliases and Mod', () => {
    expect(parseSequence('shift+ctrl+t', 'other')).toEqual(['Ctrl+Shift+T']);
    expect(parseSequence('Mod+T', 'mac')).toEqual(['Meta+T']);
    expect(parseSequence('CmdOrCtrl+Left', 'other')).toEqual(['Ctrl+ArrowLeft']);
    expect(parseSequence('G Shift+T', 'other')).toEqual(['G', 'Shift+T']);
    expect(parseSequence('Ctrl++', 'other')).toEqual(['Ctrl+Plus']);
    expect(parseSequence('Shift+?', 'other')).toEqual(['?']);
  });

  it('rejects bad chords', () => {
    for (const bad of ['', 'Ctrl+', 'Hyper+T', 'Ctrl+Ctrl+T', 'Ctrl+NoSuchKey', 'A B C D E']) {
      expect(() => parseSequence(bad, 'other'), bad).toThrow();
    }
  });

  it('matches what key events produce', () => {
    expect(chordFromInput(input('T', { control: true, shift: true }))).toBe('Ctrl+Shift+T');
    expect(chordFromInput(input('t', { control: true }))).toBe('Ctrl+T');
    expect(chordFromInput(input('?', { shift: true }))).toBe('?');
    expect(chordFromInput(input(' '))).toBe('Space');
    expect(chordFromInput(input('+', { control: true, shift: true }))).toBe('Ctrl+Shift+Plus');
    expect(chordFromInput(input('Shift', { shift: true }))).toBeUndefined();
    expect(chordFromInput(input('Dead'))).toBeUndefined();
    expect(chordFromInput(input('é'))).toBeUndefined();
  });

  it('identifies chords that could be ordinary typing', () => {
    expect(isTypingChord('G')).toBe(true);
    expect(isTypingChord('Shift+G')).toBe(true);
    expect(isTypingChord('Space')).toBe(true);
    expect(isTypingChord(':')).toBe(true);
    expect(isTypingChord('Ctrl+G')).toBe(false);
    expect(isTypingChord('F5')).toBe(false);
    expect(isTypingChord('Escape')).toBe(false);
  });

  it('formats accelerators for display', () => {
    expect(toAccelerator('Ctrl+Shift+T', 'other')).toBe('Ctrl+Shift+T');
    expect(toAccelerator('Meta+ArrowLeft', 'mac')).toBe('Cmd+Left');
  });
});

const keymaps: Keymap[] = [
  { id: 'base', label: 'Base', bindings: [
    { keys: 'Ctrl+T', command: 'tab.new' },
    { keys: 'Ctrl+W', command: 'tab.close' },
    { keys: 'F5', command: 'nav.reload' },
  ] },
  { id: 'vi', label: 'Vi', extends: 'base', bindings: [
    { keys: 'Ctrl+W', command: '-' },
    { keys: 'F5', command: 'nav.reload-hard' },
    { keys: 'G', command: 'nav.home', when: 'input.modal' },
    { keys: 'G T', command: 'tab.next', when: 'input.modal' },
    { keys: 'D', command: 'tab.close', when: 'input.modal' },
  ] },
];

describe('keymap resolution', () => {
  it('layers a profile over its base, with overrides and unbinding', () => {
    const b = resolveKeymap(keymaps, 'vi', 'other');
    expect(b.find((x) => x.sequence[0] === 'Ctrl+W')).toBeUndefined();
    expect(displayBinding(b, 'tab.new')).toEqual(['Ctrl+T']);
    const d = new KeyDispatcher(b);
    expect(d.press('F5', {})).toEqual({ kind: 'execute', command: 'nav.reload-hard' });
  });

  it('rejects unknown and circular keymaps', () => {
    expect(() => resolveKeymap(keymaps, 'nope', 'other')).toThrow(/unknown/);
    const loop: Keymap[] = [{ id: 'a', label: 'A', extends: 'b', bindings: [] }, { id: 'b', label: 'B', extends: 'a', bindings: [] }];
    expect(() => resolveKeymap(loop, 'a', 'other')).toThrow(/circular/);
  });

  it('reports duplicate and prefix conflicts within one keymap', () => {
    const b = resolveKeymap(keymaps, 'vi', 'other').filter((x) => x.source === 'vi');
    expect(findConflicts(b).map((c) => [c.kind, c.keys])).toEqual([['prefix', 'G T']]);
    const dup = resolveKeymap([{ id: 'x', label: 'X', bindings: [{ keys: 'F1', command: 'a.b' }, { keys: 'F1', command: 'a.c' }] }], 'x', 'other');
    expect(findConflicts(dup)[0]?.kind).toBe('duplicate');
  });
});

describe('key dispatch', () => {
  const modal = { 'input.modal': true };
  const make = () => new KeyDispatcher(resolveKeymap(keymaps, 'vi', 'other'));

  it('ignores modal bindings outside modal mode', () => {
    expect(make().press('D', {})).toEqual({ kind: 'none' });
    expect(make().press('D', modal)).toEqual({ kind: 'execute', command: 'tab.close' });
  });

  it('waits when a longer binding may follow, then completes it', () => {
    const d = make();
    expect(d.press('G', modal)).toEqual({ kind: 'pending' });
    expect(d.isPending).toBe(true);
    expect(d.press('T', modal)).toEqual({ kind: 'execute', command: 'tab.next' });
    expect(d.isPending).toBe(false);
  });

  it('runs the short binding when the wait times out', () => {
    const d = make();
    d.press('G', modal);
    expect(d.timeout(modal)).toEqual({ kind: 'execute', command: 'nav.home' });
  });

  it('abandons a prefix and re-reads the key that broke it', () => {
    const d = make();
    d.press('G', modal);
    expect(d.press('D', modal)).toEqual({ kind: 'execute', command: 'tab.close' });
    d.press('G', modal);
    expect(d.press('X', modal)).toEqual({ kind: 'none' });
    expect(d.isPending).toBe(false);
  });
});
