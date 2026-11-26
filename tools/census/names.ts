import type { CensusFile, CensusItem } from './types.ts';

/** Lower-case letters and digits only. */
export const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

const PREFIXES = [/^menuitem_?/i, /^mo_/i, /^idc_/i, /^menu_/i, /^cmd_/i, /^action(?=[A-Z])/, /^browser:/i, /^main:/i, /^contextMenuItemTag/];
const SUFFIXES = [/action$/i, /_?menuitem$/i, /_?item$/i];

/**
 * Normalized names a census item answers to: one from its identifier, one from its label.
 * Two items with a name in common are treated as the same command by the mapper.
 */
export function itemNames(it: CensusItem): string[] {
  const names = new Set<string>();
  let key = it.key;
  // Ladybird: "File:new_tab", Falkon: "File/NewTab": the command is the last part.
  if (/[:/]/.test(key) && !/^(main|menu|edit):/.test(key) && !/^Browser:/i.test(key)) key = key.split(/[:/]/).at(-1)!;
  for (const p of PREFIXES) key = key.replace(p, '');
  for (const s of SUFFIXES) key = key.replace(s, '');
  const k = squash(key);
  if (k.length > 1) names.add(k);
  if (it.label) {
    const l = squash(it.label);
    if (l.length > 1) names.add(l);
  }
  return [...names];
}

export interface Located {
  source: CensusFile;
  item: CensusItem;
}

export function allItems(files: readonly CensusFile[]): Located[] {
  return files.flatMap((source) => source.items.map((item) => ({ source, item })));
}
