/**
 * Link census items to canonical commands, and turn the links into lineage.
 *
 * `catalog/census/names/*.yaml` list, for each command id, the normalized names (see names.ts)
 * under which browsers offered it. `catalog/census/overrides.yaml` settles single items whose
 * name is ambiguous. Both are curated by hand; the build fails if a name belongs to two
 * commands, so a mistake cannot silently attach the wrong history to a command.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Lineage } from '../../app/core/catalog/types.ts';
import { itemNames } from './names.ts';
import { CENSUS_DIR } from './run.ts';
import type { CensusFile, CensusItem } from './types.ts';

/**
 * `command` is a command id, or `none` for an item that was read and deliberately not mapped
 * (it is a different thing from any canonical command, or not a browser command at all).
 */
export interface Override { source: string; key: string; command: string; why?: string }

/** Reads every file in catalog/census/names/ and joins the lists given for the same command. */
export function loadNames(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const dir = join(CENSUS_DIR, 'names');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yaml')).sort()) {
    const part = (parse(readFileSync(join(dir, f), 'utf8')) ?? {}) as Record<string, string[]>;
    for (const [id, list] of Object.entries(part)) out[id] = [...new Set([...(out[id] ?? []), ...list])];
  }
  return out;
}
export const loadOverrides = (): Override[] => (parse(readFileSync(join(CENSUS_DIR, 'overrides.yaml'), 'utf8')) ?? []) as Override[];

export interface Match { source: CensusFile; item: CensusItem; command: string }

export interface MergeResult {
  matches: Match[];
  unmatched: { source: CensusFile; item: CensusItem }[];
  /** Read and deliberately not mapped (override with command `none`). */
  reviewed: { source: CensusFile; item: CensusItem; why: string }[];
  problems: string[];
}

export function matchCensus(files: readonly CensusFile[], names: Record<string, string[]>, overrides: readonly Override[], commandIds: ReadonlySet<string>): MergeResult {
  const problems: string[] = [];
  const owner = new Map<string, string>();
  for (const [command, list] of Object.entries(names)) {
    if (!commandIds.has(command)) { problems.push(`names/: "${command}" is not a command`); continue; }
    for (const n of list) {
      if (n !== n.toLowerCase().replace(/[^a-z0-9]/g, '')) problems.push(`names/: "${n}" under ${command} is not normalized (lower-case letters and digits only)`);
      const prev = owner.get(n);
      if (prev && prev !== command) problems.push(`names/: "${n}" belongs to both ${prev} and ${command}`);
      owner.set(n, command);
    }
  }
  const byOverride = new Map(overrides.map((o) => [`${o.source}|${o.key}`, o]));
  const knownKeys = new Set<string>();
  const matches: Match[] = [];
  const unmatched: MergeResult['unmatched'] = [];
  const reviewed: MergeResult['reviewed'] = [];
  for (const source of files) {
    for (const item of source.items) {
      knownKeys.add(`${source.id}|${item.key}`);
      const o = byOverride.get(`${source.id}|${item.key}`);
      if (o) {
        if (o.command === 'none') reviewed.push({ source, item, why: o.why ?? '' });
        else if (!commandIds.has(o.command)) problems.push(`overrides.yaml: ${o.source} ${o.key} -> unknown command ${o.command}`);
        else matches.push({ source, item, command: o.command });
        continue;
      }
      const hits = new Set(itemNames(item).map((n) => owner.get(n)).filter((c): c is string => c !== undefined));
      if (hits.size === 1) matches.push({ source, item, command: [...hits][0]! });
      else if (hits.size > 1) problems.push(`${source.id} ${item.key}: names point at several commands (${[...hits].join(', ')}); add an override`);
      else unmatched.push({ source, item });
    }
  }
  for (const o of overrides) if (!knownKeys.has(`${o.source}|${o.key}`)) problems.push(`overrides.yaml: ${o.source} has no item ${o.key}`);
  return { matches, unmatched, reviewed, problems };
}

/** Lineage entries for one command, oldest first. */
export function lineageFor(command: string, matches: readonly Match[]): Lineage[] {
  const out: Lineage[] = [];
  for (const m of matches) {
    if (m.command !== command) continue;
    const { source, item } = m;
    // Only real labels go in the menu path; a source identifier is not something a user ever saw.
    const where = item.label ? (item.menu ? `${item.menu} > ${item.label}` : item.label) : item.menu;
    out.push({
      browser: source.browser,
      versions: source.browser_version,
      year: source.released,
      ...(where ? { menu: where } : {}),
      // A manual is someone's description of the browser, read by OCR; the browser's own code is `census`.
      // A dump of a program's own menu resources is the browser's own data, as strong as its code.
      source: source.source.host === 'archive.org' ? 'manual' : source.source.host === 'local' ? 'screenshot' : 'census',
      key: item.key,
      ref: source.source.host === 'archive.org'
        ? `archive.org/${source.source.repo}/${item.file ?? source.source.files[0]!.path}#L${item.line}`
        : source.source.host === 'local'
          ? `commons/${source.source.repo}#L${item.line}`
          : source.source.host === 'dump'
            ? `dump/${source.source.repo}/${item.file ?? source.source.files[0]!.path}#L${item.line}`
            : source.source.host === 'machine'
              ? `machine/${item.file ?? source.source.files[0]!.path}#L${item.line}`
          : `${source.source.repo}@${source.source.commit.slice(0, 12)}:${item.file ?? source.source.files[0]!.path}#L${item.line}`,
    });
  }
  return out.sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || a.browser.localeCompare(b.browser));
}
