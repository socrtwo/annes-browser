/**
 * Opera 7–12 (Presto) menu specification files (`standard_menu.ini`) as rc-syntax
 * menus, for the `rc-menu` extractor. See tools/opera-dump.ts.
 */
const rc = (s: string) => s.replace(/"/g, "'").replace(/[\u0000-\u001f]/g, ' ').trim();

/**
 * Each `Item, <STRING_ID> = <action>` line becomes a MENUITEM labelled with Opera's
 * own action name and its first argument ("Manage, 'bookmarks'" → "Manage bookmarks").
 * The visible labels live in the language file, keyed by hashes that cannot be mapped back.
 * `Platform …, `, `Feature …, ` and `Language …, ` prefixes are kept in the comment.
 */
export function operaMenusToRc(text: string, header: string[]): { text: string; items: number } {
  const lines = [...header.map((h) => `# ${h}`), '', 'OPERA MENU', '{'];
  let section: string | undefined;
  let open = false;
  let items = 0;
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((l, i) => {
    const sec = /^\[(.+)\]\s*$/.exec(l);
    if (sec) {
      if (open) lines.push('    }');
      section = sec[1]!;
      open = !/^(Version|Info)$/.test(section);
      if (open) lines.push(`    POPUP "${rc(section)}"`, '    {');
      return;
    }
    if (!open || !section) return;
    const m = /^\s*((?:(?:Platform|Feature|Language)\s+[^,]+,\s*)*)Item\s*,\s*("[^"]*"|[^=\s]+)\s*=\s*(.+?)\s*$/.exec(l);
    if (!m) return;
    const id = m[2]!.startsWith('"') ? `LITERAL_${i + 1}` : m[2]!.replace(/\W/g, '_');
    const full = m[1] ? `${m[3]!} [${m[1].replace(/,\s*$/, '').replace(/,\s*/g, '; ')}]` : m[3]!;
    const [name, ...params] = m[3]!.split(/\s*(?:\||>|\+)\s*/)[0]!.split(',').map((x) => x.trim());
    const arg = params.find((x) => x && x !== '0' && x !== '1' && x !== '-1')?.replace(/^(['"])(.*)\1$/, '$2');
    const action = arg && !/^[A-Z_]+$/.test(arg) ? `${name} ${arg}` : name!;
    if (!action) return;
    lines.push(`        MENUITEM "${rc(action)}", ${id}    // ${rc(full)}`);
    items++;
  });
  if (open) lines.push('    }');
  lines.push('}', '');
  return { text: lines.join('\n'), items };
}
