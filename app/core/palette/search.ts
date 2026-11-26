import type { CommandRecord } from '../catalog/types.ts';

export interface PaletteHit {
  id: string;
  label: string;
  /** What matched when it was not the label, e.g. `Netscape Communicator: File > Edit Page`. */
  via?: string;
  /** The command is catalogued but not built yet. */
  planned?: true;
  score: number;
}

interface Field {
  text: string;
  lower: string;
  weight: number;
  isLabel: boolean;
}

interface Entry {
  record: CommandRecord;
  fields: Field[];
}

/**
 * Score `term` against `text` as a subsequence match. Higher is better;
 * 0 means no match. Rewards matches at word starts and runs of consecutive
 * characters, so "rct" finds "Reopen Closed Tab".
 */
export function fuzzyScore(term: string, lower: string): number {
  const exact = lower.indexOf(term);
  if (exact >= 0) {
    const atWord = exact === 0 || !/[a-z0-9]/.test(lower[exact - 1]!);
    return 100 + term.length * 4 + (atWord ? 30 : 0) - Math.min(exact, 20);
  }
  let score = 0;
  let ti = 0;
  let run = 0;
  for (let i = 0; i < lower.length && ti < term.length; i++) {
    if (lower[i] !== term[ti]) { run = 0; continue; }
    const atWord = i === 0 || !/[a-z0-9]/.test(lower[i - 1]!);
    score += 2 + (atWord ? 8 : 0) + run * 3;
    run++;
    ti++;
  }
  return ti === term.length ? score : 0;
}

/**
 * Command palette index. Searches labels, aliases, ids and lineage, so both
 * "reopen" and "netscape edit page" find their commands.
 */
export class PaletteIndex {
  private readonly entries: Entry[];
  private readonly isPlanned: (id: string) => boolean;

  /** Commands for which `isPlanned` is true rank below built commands with a similar match. */
  constructor(commands: readonly CommandRecord[], isPlanned: (id: string) => boolean = () => false) {
    this.isPlanned = isPlanned;
    const field = (text: string, weight: number, isLabel = false): Field => ({ text, lower: text.toLowerCase(), weight, isLabel });
    this.entries = commands.map((record) => ({
      record,
      fields: [
        field(record.label, 1, true),
        ...(record.aliases ?? []).map((a) => field(a, 0.9)),
        field(record.id, 0.6),
        ...(record.lineage ?? []).map((l) => field(l.menu ? `${l.browser}: ${l.menu}` : l.browser, 0.7)),
      ],
    }));
  }

  search(query: string, limit = 20): PaletteHit[] {
    const terms = query.toLowerCase().slice(0, 100).split(/\s+/).filter(Boolean).slice(0, 6);
    if (terms.length === 0) {
      return [...this.entries]
        .sort((a, b) => Number(this.isPlanned(a.record.id)) - Number(this.isPlanned(b.record.id)))
        .slice(0, limit)
        .map((e) => ({ id: e.record.id, label: e.record.label, score: 0, ...(this.isPlanned(e.record.id) && { planned: true as const }) }));
    }
    const hits: PaletteHit[] = [];
    for (const { record, fields } of this.entries) {
      let total = 0;
      let via: Field | undefined;
      let viaScore = 0;
      let matched = true;
      for (const term of terms) {
        let best = 0;
        let bestField: Field | undefined;
        for (const f of fields) {
          const s = fuzzyScore(term, f.lower) * f.weight;
          if (s > best) { best = s; bestField = f; }
        }
        if (best === 0) { matched = false; break; }
        total += best;
        if (bestField && !bestField.isLabel && best > viaScore) { via = bestField; viaScore = best; }
      }
      if (!matched) continue;
      const planned = this.isPlanned(record.id);
      hits.push({
        id: record.id, label: record.label, score: planned ? total * 0.6 : total,
        ...(via && { via: via.text }), ...(planned && { planned: true as const }),
      });
    }
    return hits.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, limit);
  }
}
