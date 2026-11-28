import type { CommandRecord, LayoutItem, MenuLayout } from '../catalog/types.ts';
import { CATEGORIES } from '../catalog/types.ts';
import type { Context } from '../when/when.ts';

/** A menu ready to hand to a platform adapter (Electron, Android). */
export type MenuNode =
  | { type: 'separator' }
  | { type: 'submenu'; label: string; items: MenuNode[] }
  | {
      type: 'command';
      id: string;
      /** Arguments for generated items (layout choices, bookmark entries). Layout files never set them. */
      args?: Record<string, string | number | boolean>;
      label: string;
      enabled: boolean;
      /** Present only for toggle commands. */
      checked?: boolean;
      /** Canonical chord sequence to display, if the command has a binding. */
      keys?: string[];
      /** The command is a `stub`: choosing it explains why the feature is gone. */
      stub: boolean;
    };

export interface MenuSources {
  /** Returns undefined for unknown, omitted or wrong-platform commands. */
  command(id: string): CommandRecord | undefined;
  isEnabled(id: string, ctx: Context): boolean;
  isChecked(id: string, ctx: Context): boolean | undefined;
  keysFor(id: string): string[] | undefined;
}

function tidy(items: MenuNode[]): MenuNode[] {
  const out: MenuNode[] = [];
  for (const item of items) {
    if (item.type === 'submenu' && item.items.length === 0) continue;
    if (item.type === 'separator' && (out.length === 0 || out.at(-1)!.type === 'separator')) continue;
    out.push(item);
  }
  while (out.at(-1)?.type === 'separator') out.pop();
  return out;
}

function buildItems(items: readonly LayoutItem[], src: MenuSources, ctx: Context): MenuNode[] {
  return tidy(
    items.flatMap((item): MenuNode[] => {
      if (typeof item !== 'string') {
        if ('separator' in item) return [{ type: 'separator' }];
        if ('items' in item) return [{ type: 'submenu', label: item.label, items: buildItems(item.items, src, ctx) }];
      }
      const id = typeof item === 'string' ? item : item.command;
      const record = src.command(id);
      if (!record) return [];
      const checked = src.isChecked(id, ctx);
      const keys = src.keysFor(id);
      return [{
        type: 'command',
        id: record.id,
        label: typeof item === 'string' ? record.label : item.label,
        // Stubs stay clickable so the user can read why the feature is unavailable.
        enabled: record.status === 'stub' || src.isEnabled(id, ctx),
        stub: record.status === 'stub',
        ...(checked !== undefined && { checked }),
        ...(keys !== undefined && { keys }),
      }];
    }),
  );
}

/** Build the menu bar for a layout in the current context. */
export function buildMenu(layout: MenuLayout, src: MenuSources, ctx: Context): MenuNode[] {
  return tidy(layout.menus.map((m) => ({ type: 'submenu', label: m.label, items: buildItems(m.items, src, ctx) })));
}

const CATEGORY_LABELS: Record<string, string> = {
  app: 'Application', nav: 'Navigate', tab: 'Tabs', bookmark: 'Bookmarks', extract: 'Extract',
  legacy: 'Legacy', module: 'Modules', privacy: 'Privacy', input: 'Input',
};

/**
 * The "Everything" layout: every visible command, one menu per category,
 * sorted by label. Generated, so a new catalog entry appears without any
 * layout edit.
 */
export function everythingLayout(commands: readonly CommandRecord[]): MenuLayout {
  return {
    id: 'everything',
    label: 'Everything',
    description: 'Every command, grouped by category.',
    menus: CATEGORIES.map((cat) => ({
      label: CATEGORY_LABELS[cat] ?? cat[0]!.toUpperCase() + cat.slice(1),
      items: commands
        .filter((c) => c.category === cat)
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((c) => c.id),
    })),
  };
}

/** Every command id a layout mentions, for build-time validation. */
export function layoutCommandIds(layout: MenuLayout): string[] {
  const walk = (items: readonly LayoutItem[]): string[] =>
    items.flatMap((i) => (typeof i === 'string' ? [i] : 'command' in i ? [i.command] : 'items' in i ? walk(i.items) : []));
  return layout.menus.flatMap((m) => walk(m.items));
}
