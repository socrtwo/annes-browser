import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CENSUS_DIR, loadCensus, loadSources } from './census/run.ts';
import type { CensusFile } from './census/types.ts';

/** Every census file present, in manifest order. */
export function loadAllCensus(): CensusFile[] {
  return loadSources().filter((s) => existsSync(join(CENSUS_DIR, `${s.id}.yaml`))).map((s) => loadCensus(s.id));
}
