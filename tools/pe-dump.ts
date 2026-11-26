/**
 * Dump the menus of Windows programs into catalog/census/transcriptions/.
 *
 *   node tools/pe-dump.ts [--no-status-text] <out-name.txt> <source-url> <note> <program> [<program> ...]
 *
 * --no-status-text: the program does not keep a command's status-bar text under the command's
 * own id (MFC does; Internet Explorer does not), so the string table would give wrong text.
 *
 * <source-url> is the archive.org download the programs were unpacked from;
 * <note> says how (which archive inside, which path). Programs are only read,
 * never run. Each program's name and SHA-256 are recorded, so anyone can
 * re-derive the file. With several programs, each menu is prefixed with its
 * program's name.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readResources, toRc } from './census/pe.ts';

const args = process.argv.slice(2);
const statusText = args[0] !== '--no-status-text';
if (!statusText) args.shift();
const [out, url, note, ...programs] = args;
if (!out || !url || !note || programs.length === 0) {
  console.error('usage: node tools/pe-dump.ts <out-name.txt> <source-url> <note> <program> [<program> ...]');
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9.-]*\.txt$/.test(out)) throw new Error(`not a transcription file name: ${out}`);
if (!/^https:\/\/archive\.org\/download\/[\w.-]+\/\S+$/.test(url)) throw new Error('source must be an https://archive.org/download/<item>/<file> address');

const header = [
  "Menus read from Windows programs' own resources by tools/pe-dump.ts (the programs were not run).",
  `download: ${url}`,
  `unpacked: ${note}`,
];
const parts: string[] = [];
let menus = 0;
for (const p of programs) {
  const buf = readFileSync(p);
  const res = readResources(buf);
  menus += res.menus.size;
  header.push(`program: ${basename(p)}, sha256 ${createHash('sha256').update(buf).digest('hex')}: ${res.menus.size} menus, ${res.accelerators.length} shortcuts`);
  parts.push(toRc(res, [], programs.length > 1 ? basename(p).replace(/\..*$/, '').toLowerCase() : undefined, statusText));
}
header.push(statusText
  ? "Each MENUITEM: label, command id; the comment is the program's status-bar text for that id, and its shortcut."
  : "Each MENUITEM: label, command id; the comment is its shortcut. (This program does not keep status-bar text by command id.)");
const text = `${header.map((h) => `# ${h}`).join('\n')}\n${parts.join('')}`;
writeFileSync(join(import.meta.dirname, '..', 'catalog', 'census', 'transcriptions', out), text);
console.log(`${out}: ${menus} menus, ${text.split('\n').filter((l) => /^\s*MENUITEM "/.test(l)).length} items`);
