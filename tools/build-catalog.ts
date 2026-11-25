/**
 * Compile catalog/*.yaml into dist/catalog.json.
 *
 *   node tools/build-catalog.ts
 *
 * Fails (exit 1) on any schema violation or cross-reference error, so an
 * invalid catalog can never be packaged.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { parse } from 'yaml';
import type { Catalog } from '../app/core/catalog/types.ts';
import { validateCatalog } from '../app/core/catalog/validate.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readYaml = (path: string): unknown => parse(readFileSync(path, 'utf8'), { maxAliasCount: 0 });
const readDir = (dir: string): unknown[] =>
  readdirSync(join(root, dir)).filter((f) => f.endsWith('.yaml')).sort().map((f) => readYaml(join(root, dir, f)));

export function loadCatalog(): Catalog {
  return {
    version: 1,
    commands: readDir('catalog/commands').flat() as Catalog['commands'],
    layouts: readDir('catalog/layouts') as Catalog['layouts'],
    keymaps: readDir('catalog/keymaps') as Catalog['keymaps'],
  };
}

export function checkCatalog(catalog: Catalog): { errors: string[]; warnings: string[] } {
  const schema = JSON.parse(readFileSync(join(root, 'schema/catalog.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!ajv.validate(schema, catalog)) {
    for (const e of ajv.errors ?? []) errors.push(`schema ${e.instancePath || '/'}: ${e.message} ${JSON.stringify(e.params)}`);
    return { errors, warnings };
  }
  for (const p of validateCatalog(catalog)) (p.level === 'error' ? errors : warnings).push(`${p.where}: ${p.message}`);
  return { errors, warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = loadCatalog();
  const { errors, warnings } = checkCatalog(catalog);
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`catalog: ${errors.length} error(s)`);
    process.exit(1);
  }
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist/catalog.json'), JSON.stringify(catalog));
  console.log(`catalog: ${catalog.commands.length} commands, ${catalog.layouts.length} layouts, ${catalog.keymaps.length} keymaps`);
}
