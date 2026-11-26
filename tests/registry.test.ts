import { describe, expect, it, vi } from 'vitest';
import type { CommandRecord } from '../app/core/catalog/types.ts';
import { buildMenu, everythingLayout } from '../app/core/menu/build.ts';
import { PaletteIndex } from '../app/core/palette/search.ts';
import { CommandRegistry } from '../app/core/registry.ts';

const cmd = (id: string, extra: Partial<CommandRecord> = {}): CommandRecord => ({
  id, label: id, category: id.split('.')[0] as CommandRecord['category'], description: id,
  status: 'implement', phase: 2, platforms: ['desktop'], ...extra,
});

const commands: CommandRecord[] = [
  cmd('nav.back', { label: 'Back', when: 'tab.canGoBack' }),
  cmd('nav.go', { label: 'Go', requires: ['network'], args: [{ name: 'text', type: 'string' }, { name: 'newTab', type: 'boolean', optional: true }] }),
  cmd('view.full-screen', { label: 'Full Screen', checked: 'window.isFullScreen' }),
  cmd('tools.passwords', { label: 'Passwords', requires: ['credentials'] }),
  cmd('legacy.activex', { label: 'ActiveX', status: 'stub', status_reason: 'unsafe' }),
  cmd('legacy.channels', { label: 'Channels', status: 'omit', status_reason: 'defunct' }),
  cmd('tab.android-only', { label: 'Android Only', platforms: ['android'] }),
  cmd('tab.reopen-closed', { label: 'Reopen Closed Tab', aliases: ['Undo Close Tab'], lineage: [{ browser: 'Firefox', menu: 'History > Recently Closed Tabs' }] }),
  cmd('page.edit', { label: 'Edit Page', lineage: [{ browser: 'Netscape Communicator', menu: 'File > Edit Page' }] }),
];

function make(ctx: Record<string, boolean> = {}) {
  const hooks = { onStub: vi.fn(), onUnimplemented: vi.fn(), onError: vi.fn() };
  const registry = new CommandRegistry<string>({ commands }, { platform: 'desktop', getContext: () => ctx, ...hooks });
  return { registry, hooks };
}
const inv = (args?: Record<string, unknown>, source: 'menu' | 'macro' | 'extension' = 'menu') =>
  ({ source, host: 'w1', ...(args && { args }) });

describe('command registry', () => {
  it('runs a handler with validated arguments and notifies listeners', async () => {
    const { registry } = make();
    const handler = vi.fn();
    const seen = vi.fn();
    registry.register('nav.go', handler);
    registry.onDidExecute(seen);
    expect(await registry.execute('nav.go', inv({ text: 'example.com' }))).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledWith('w1', { text: 'example.com' });
    expect(seen).toHaveBeenCalledWith({ id: 'nav.go', source: 'menu', args: { text: 'example.com' } });
  });

  it('rejects bad arguments before the handler runs', async () => {
    const { registry } = make();
    const handler = vi.fn();
    registry.register('nav.go', handler);
    for (const args of [{}, { text: 5 }, { text: 'x', extra: 1 }, { text: 'x', newTab: 'yes' }, { text: 'x'.repeat(9000) }, { text: { toString: () => 'x' } }]) {
      expect((await registry.execute('nav.go', inv(args))).ok).toBe(false);
    }
    expect((await registry.execute('nav.back', inv({ anything: 1 }))).ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('enforces enablement', async () => {
    const { registry } = make({ 'tab.canGoBack': false });
    registry.register('nav.back', vi.fn());
    expect(await registry.execute('nav.back', inv())).toMatchObject({ ok: false, reason: 'disabled' });
  });

  it('limits what macros and extensions may do', async () => {
    const { registry } = make();
    const go = vi.fn();
    const pw = vi.fn();
    registry.register('nav.go', go);
    registry.register('tools.passwords', pw);
    expect((await registry.execute('nav.go', inv({ text: 'x' }, 'macro'))).ok).toBe(true);
    expect(await registry.execute('tools.passwords', inv(undefined, 'macro'))).toMatchObject({ reason: 'forbidden' });
    expect(await registry.execute('nav.go', inv({ text: 'x' }, 'extension'))).toMatchObject({ reason: 'forbidden' });
    expect(pw).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('handles stub, omitted, other-platform, unknown and unimplemented commands', async () => {
    const { registry, hooks } = make();
    expect(await registry.execute('legacy.activex', inv())).toMatchObject({ reason: 'stub', message: 'unsafe' });
    expect(hooks.onStub).toHaveBeenCalledOnce();
    expect(await registry.execute('legacy.channels', inv())).toMatchObject({ reason: 'omitted' });
    expect(await registry.execute('tab.android-only', inv())).toMatchObject({ reason: 'platform' });
    expect(await registry.execute('no.such', inv())).toMatchObject({ reason: 'unknown' });
    expect(await registry.execute('view.full-screen', inv())).toMatchObject({ reason: 'unimplemented' });
    expect(hooks.onUnimplemented).toHaveBeenCalledOnce();
  });

  it('contains handler failures', async () => {
    const { registry, hooks } = make();
    registry.register('view.full-screen', () => { throw new Error('boom'); });
    expect(await registry.execute('view.full-screen', inv())).toMatchObject({ reason: 'failed' });
    expect(hooks.onError).toHaveBeenCalledOnce();
  });

  it('refuses handlers for unknown, stub or already-handled commands', () => {
    const { registry } = make();
    registry.register('nav.back', vi.fn());
    expect(() => registry.register('nav.back', vi.fn())).toThrow();
    expect(() => registry.register('legacy.activex', vi.fn())).toThrow();
    expect(() => registry.register('no.such', vi.fn())).toThrow();
  });
});

describe('menu builder', () => {
  const { registry } = make({ 'tab.canGoBack': false, 'window.isFullScreen': true });
  const visible = new Map(registry.visible().map((c) => [c.id, c]));
  const src = {
    command: (id: string) => visible.get(id),
    isEnabled: (id: string, ctx: Record<string, boolean>) => registry.isEnabled(id, ctx),
    isChecked: (id: string, ctx: Record<string, boolean>) => registry.isChecked(id, ctx),
    keysFor: (id: string) => (id === 'nav.back' ? ['Alt+ArrowLeft'] : undefined),
  };
  const ctx = { 'tab.canGoBack': false, 'window.isFullScreen': true };

  it('builds enabled, checked and stub states and drops unavailable commands', () => {
    const menu = buildMenu({
      id: 't', label: 'T',
      menus: [
        { label: 'Go', items: [{ separator: true }, 'nav.back', { separator: true }, { separator: true }, 'view.full-screen', 'legacy.channels', 'tab.android-only', 'no.such', { separator: true }] },
        { label: 'Empty', items: ['legacy.channels', { label: 'Also empty', items: [] }] },
        { label: 'Legacy', items: ['legacy.activex'] },
      ],
    }, src, ctx);
    expect(menu).toEqual([
      { type: 'submenu', label: 'Go', items: [
        { type: 'command', id: 'nav.back', label: 'Back', enabled: false, stub: false, keys: ['Alt+ArrowLeft'] },
        { type: 'separator' },
        { type: 'command', id: 'view.full-screen', label: 'Full Screen', enabled: true, stub: false, checked: true },
      ] },
      { type: 'submenu', label: 'Legacy', items: [{ type: 'command', id: 'legacy.activex', label: 'ActiveX', enabled: true, stub: true }] },
    ]);
  });

  it('generates the Everything layout from categories', () => {
    const layout = everythingLayout(registry.visible());
    const ids = layout.menus.flatMap((m) => m.items);
    expect(ids).toContain('legacy.activex');
    expect(ids).not.toContain('legacy.channels');
    expect(ids).not.toContain('tab.android-only');
    expect(new Set(ids).size).toBe(registry.visible().length);
  });
});

describe('palette search', () => {
  const index = new PaletteIndex(commands.filter((c) => c.status !== 'omit'));

  it('finds commands by label, initials, alias and lineage', () => {
    expect(index.search('back')[0]?.id).toBe('nav.back');
    expect(index.search('rct')[0]?.id).toBe('tab.reopen-closed');
    expect(index.search('undo close')[0]).toMatchObject({ id: 'tab.reopen-closed', via: 'Undo Close Tab' });
    expect(index.search('netscape edit')[0]?.id).toBe('page.edit');
    expect(index.search('zzzz')).toEqual([]);
  });

  it('ranks built commands above planned ones and marks the planned', () => {
    const idx = new PaletteIndex(commands.filter((c) => c.status !== 'omit'), (id) => id === 'nav.back');
    const hits = idx.search('back');
    expect(hits[0]).toMatchObject({ id: 'nav.back', planned: true });
    const both = new PaletteIndex([cmd('nav.back', { label: 'Back' }), cmd('nav.back-page', { label: 'Back Page' })], (id) => id === 'nav.back');
    expect(both.search('back').map((h) => h.id)).toEqual(['nav.back-page', 'nav.back']);
    expect(both.search('').map((h) => h.id)).toEqual(['nav.back-page', 'nav.back']);
  });

  it('bounds its work on hostile queries', () => {
    expect(index.search('a '.repeat(5000)).length).toBeLessThanOrEqual(20);
    expect(index.search('', 3)).toHaveLength(3);
  });
});
