/**
 *   npm run census -- pin        resolve each source's ref to a commit SHA
 *   npm run census -- extract    read the pinned sources and write catalog/census/<id>.yaml
 *   npm run census -- verify     re-read every source and check every citation
 *   npm run census -- report     print counts per source
 *   npm run census -- docs       write docs/CENSUS.md and docs/census-unlinked.tsv
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog, applyCensus } from './build-catalog.ts';
import { loadAllCensus } from './census-load.ts';
import { writeCensusReports } from './census/report.ts';
import { buildCensus, CENSUS_DIR, loadCensus, loadSources, pinSources, verifyCensus, writeCensus } from './census/run.ts';

const [cmd, ...rest] = process.argv.slice(2);
const only = rest.filter((a) => !a.startsWith('-'));
const selected = () => loadSources().filter((s) => only.length === 0 || only.includes(s.id));

switch (cmd) {
  case 'pin': {
    console.log(`pinned ${pinSources()} source(s)`);
    break;
  }
  case 'extract': {
    const today = new Date().toISOString().slice(0, 10);
    for (const spec of selected()) {
      const c = await buildCensus(spec, today);
      writeCensus(c);
      console.log(`${spec.id.padEnd(20)} ${String(c.items.length).padStart(4)} items`);
    }
    break;
  }
  case 'verify': {
    let bad = 0;
    for (const spec of selected()) {
      if (!existsSync(join(CENSUS_DIR, `${spec.id}.yaml`))) { console.log(`${spec.id}: no census file`); bad++; continue; }
      const problems = await verifyCensus(loadCensus(spec.id));
      for (const p of problems) console.log(`${p.id}: ${p.message}`);
      bad += problems.length;
      if (problems.length === 0) console.log(`${spec.id.padEnd(20)} ok`);
    }
    process.exit(bad === 0 ? 0 : 1);
  }
  case 'report': {
    for (const spec of selected()) {
      if (!existsSync(join(CENSUS_DIR, `${spec.id}.yaml`))) continue;
      const c = loadCensus(spec.id);
      const labelled = c.items.filter((i) => i.label).length;
      console.log(`${spec.id.padEnd(20)} ${String(c.items.length).padStart(4)} items, ${labelled} with labels`);
    }
    break;
  }
  case 'docs': {
    const catalog = loadCatalog();
    applyCensus(catalog);
    const { problems } = writeCensusReports(loadAllCensus(), catalog, new Date().toISOString().slice(0, 10));
    for (const p of problems) console.error(`problem: ${p}`);
    console.log('wrote docs/CENSUS.md and docs/census-unlinked.tsv');
    process.exit(problems.length === 0 ? 0 : 1);
  }
  default:
    console.error('usage: census <pin|extract|verify|report|docs> [source-id...]');
    process.exit(2);
}
