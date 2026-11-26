/**
 * Command catalog types. The catalog is data: `catalog/commands.yaml` is
 * validated and compiled to `dist/catalog.json` at build time, and everything
 * else (menus, palette, keybindings, help) is derived from it.
 */

export const CATEGORIES = [
  'app', 'file', 'edit', 'view', 'nav', 'tab', 'bookmark', 'history', 'page',
  'tools', 'privacy', 'input', 'extract', 'legacy', 'module', 'help',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** How a catalogued command is treated. See docs/COMMAND-CATALOG.md. */
export type CommandStatus = 'implement' | 'emulate' | 'stub' | 'omit';

export type Platform = 'desktop' | 'android';

/**
 * Capabilities a command needs. A command can only run if the invoking
 * source is allowed every capability it requires (see registry.ts).
 */
export const CAPABILITIES = [
  'network', 'filesystem', 'clipboard', 'external-app', 'page-script', 'history', 'credentials',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type ArgType = 'string' | 'number' | 'boolean' | 'url';

export interface ArgSpec {
  name: string;
  type: ArgType;
  optional?: boolean;
  description?: string;
}

export interface Lineage {
  browser: string;
  versions?: string;
  menu?: string;
  year?: number;
  /**
   * `census`: read from the browser's source code; `ref` names the file and line.
   * `manual`: read from the OCR text of a published manual; `ref` names the scan and line. A
   *   third party's description, so weaker than `census`.
   * `screenshot`: transcribed from a screenshot; `ref` names the image. Shows only what was visible.
   * `recalled`: written from memory and not yet checked. Treat as a lead, not a fact.
   */
  source?: 'census' | 'manual' | 'screenshot' | 'recalled';
  /** Source-native identifier, for census entries. */
  key?: string;
  /** `owner/repo@commit:path#Lline` for census entries; `archive.org/item/file#Lline` for manuals. */
  ref?: string;
}

export interface CommandRecord {
  /** Stable dotted id, e.g. `tab.reopen-closed`. */
  id: string;
  label: string;
  aliases?: string[];
  category: Category;
  description: string;
  lineage?: Lineage[];
  status: CommandStatus;
  /** Required for `emulate`, `stub` and `omit`: shown to the user for stubs. */
  status_reason?: string;
  phase: number;
  platforms: Platform[];
  /** Context expression; the command is enabled only while it is true. */
  when?: string;
  /** Context expression; if present the command is a toggle and this is its checked state. */
  checked?: string;
  requires?: Capability[];
  args?: ArgSpec[];
}

/** A menu layout: an era-specific arrangement of commands. */
export type LayoutItem =
  | string /* command id */
  | { separator: true }
  | { label: string; items: LayoutItem[] };

export interface MenuLayout {
  id: string;
  label: string;
  description?: string;
  menus: { label: string; items: LayoutItem[] }[];
}

/** A keymap profile: chord sequence -> command id, optionally scoped by `when`. */
export interface KeymapBinding {
  keys: string;
  command: string;
  when?: string;
  args?: Record<string, unknown>;
}

export interface Keymap {
  id: string;
  label: string;
  /** Id of a keymap this one layers on top of. */
  extends?: string;
  bindings: KeymapBinding[];
}

/** The compiled catalog shipped with the app. */
export interface Catalog {
  version: 1;
  commands: CommandRecord[];
  layouts: MenuLayout[];
  keymaps: Keymap[];
}
