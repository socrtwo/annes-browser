/**
 * Dump Vivaldi's menus into catalog/census/transcriptions/.
 *
 *   node tools/vivaldi-dump.ts <out-name.txt> <source-url> <note> <resources/vivaldi directory>
 *
 * Reads menus/mainmenu.json, menus/contextmenu.json and bundle.js (for labels).
 * Only facts are kept (menu, action id, label); no file is copied.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vivaldiLabels, vivaldiMenusToRc } from './census/vivaldi.ts';

const [out, url, note, dir] = process.argv.slice(2);
if (!out || !url || !note || !dir) {
  console.error('usage: node tools/vivaldi-dump.ts <out-name.txt> <source-url> <note> <resources/vivaldi directory>');
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9.-]*\.txt$/.test(out)) throw new Error(`not a transcription file name: ${out}`);
if (!/^https:\/\/archive\.org\/download\/[\w.-]+\/\S+$/.test(url)) throw new Error('source must be an https://archive.org/download/<item>/<file> address');

const read = (p: string) => readFileSync(join(dir, p));
const files = ['menus/mainmenu.json', 'menus/contextmenu.json', 'bundle.js'].map((p) => ({ p, b: read(p) }));
const labels = vivaldiLabels(files[2]!.b.toString('utf8'));
const { text, items } = vivaldiMenusToRc(JSON.parse(files[0]!.b.toString('utf8')), JSON.parse(files[1]!.b.toString('utf8')), labels, [
  "Menus read from Vivaldi's own menu files by tools/vivaldi-dump.ts; labels from its command table in bundle.js.",
  `download: ${url}`,
  `unpacked: ${note}`,
  ...files.map(({ p, b }) => `file: ${p}, sha256 ${createHash('sha256').update(b).digest('hex')}`),
  'Each MENUITEM: label, Vivaldi action id.',
]);
writeFileSync(join(import.meta.dirname, '..', 'catalog', 'census', 'transcriptions', out), text);
console.log(`${out}: ${items} items, ${labels.size} labels known`);
