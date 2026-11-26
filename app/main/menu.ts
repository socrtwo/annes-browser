import { Menu, type MenuItemConstructorOptions } from 'electron';
import { type OS, toAccelerator } from '../core/keys/chord.ts';
import type { MenuNode } from '../core/menu/build.ts';

export type RunMenuItem = (id: string, args?: Record<string, string | number | boolean>) => void;

function toTemplate(nodes: readonly MenuNode[], os: OS, run: RunMenuItem): MenuItemConstructorOptions[] {
  return nodes.map((n): MenuItemConstructorOptions => {
    if (n.type === 'separator') return { type: 'separator' };
    if (n.type === 'submenu') return { label: n.label.replace(/&/g, '&&'), submenu: toTemplate(n.items, os, run) };
    return {
      label: (n.stub ? `${n.label} (retired)` : n.label).replace(/&/g, '&&'),
      enabled: n.enabled,
      ...(n.checked !== undefined && { type: 'checkbox' as const, checked: n.checked }),
      // Shortcuts are shown here but handled by the key dispatcher, so a key is never acted on twice.
      ...(n.keys?.length === 1 && { accelerator: toAccelerator(n.keys[0]!, os), registerAccelerator: false }),
      ...(n.keys && n.keys.length > 1 && { sublabel: n.keys.join(' ') }),
      click: () => run(n.id, n.args),
    };
  });
}

export function toElectronMenu(nodes: readonly MenuNode[], os: OS, run: RunMenuItem): Menu {
  return Menu.buildFromTemplate(toTemplate(nodes, os, run));
}
