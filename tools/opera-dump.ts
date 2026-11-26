/**
 * Dump the menus of Opera 7–12 (Presto) from its menu specification file into
 * catalog/census/transcriptions/, in rc syntax so the `rc-menu` extractor reads it.
 *
 *   node tools/opera-dump.ts <out-name.txt> <source-url> <note> <standard_menu.ini>
 *
 * Only facts are kept (section, string id, action); the file itself is not copied.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { operaMenusToRc } from './census/opera.ts';

const [out, url, note, ini] = process.argv.slice(2);
if (!out || !url || !note || !ini) {
  console.error('usage: node tools/opera-dump.ts <out-name.txt> <source-url> <note> <standard_menu.ini>');
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9.-]*\.txt$/.test(out)) throw new Error(`not a transcription file name: ${out}`);
if (!/^https:\/\/archive\.org\/download\/[\w.-]+\/\S+$/.test(url)) throw new Error('source must be an https://archive.org/download/<item>/<file> address');

const buf = readFileSync(ini);
const { text, items } = operaMenusToRc(buf.toString('utf8'), [
  "Menus read from Opera's menu specification file by tools/opera-dump.ts.",
  `download: ${url}`,
  `unpacked: ${note}`,
  `file: ${basename(ini)}, sha256 ${createHash('sha256').update(buf).digest('hex')}`,
  "Each MENUITEM: Opera's action name, then the string id of the label; the comment is the full action.",
]);
writeFileSync(join(import.meta.dirname, '..', 'catalog', 'census', 'transcriptions', out), text);
console.log(`${out}: ${items} items`);
