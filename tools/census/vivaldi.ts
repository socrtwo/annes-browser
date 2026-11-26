/**
 * Vivaldi's menus (`resources/vivaldi/menus/mainmenu.json` and `contextmenu.json`) as
 * rc-syntax menus for the `rc-menu` extractor. Labels come from Vivaldi's own command
 * table in `bundle.js` (`{name:"COMMAND_X", …("Label")}`); an action without one keeps its id.
 */

interface Node { action?: string; type?: string; children?: Node[]; name?: string }

const rc = (s: string) => s.replace(/"/g, "'").replace(/[\u0000-\u001f]/g, ' ').trim();

/** The call Vivaldi's bundle wraps a label in: `...(0,X.Z)("Label")` (6.x) or `...Object(X.a)("command","Label")` (3.x). */
const LABEL = String.raw`\.\.\.(?:\(0,[\w$]+\.\w+\)|Object\([\w$]+\.\w+\))\((?:"[\w-]+",)?"([^"]+)"\)`;

/**
 * Action and menu ids to English labels, read from the minified command tables:
 * `{name:"COMMAND_X", …(label)}` for commands and `case"DOCUMENT_X":return{…(label)}` for
 * context-menu entries. The first label inside each entry counts; an id without one keeps its own name.
 */
export function vivaldiLabels(bundle: string): Map<string, string> {
  const out = new Map<string, string>();
  const label = new RegExp(LABEL);
  // An entry ends at the next entry or at the end of its own object; a label after that belongs to something else.
  const scan = (re: RegExp, ends: string[]) => {
    for (const m of bundle.matchAll(re)) {
      const rest = bundle.slice(m.index!, m.index! + 2000);
      const end = Math.min(...ends.map((e) => rest.indexOf(e, 6)).filter((x) => x > 0), rest.length);
      const l = label.exec(rest.slice(0, end));
      if (l && !out.has(m[1]!)) out.set(m[1]!, l[1]!);
    }
  };
  scan(/name:"([A-Z][A-Z0-9_]+)"/g, ['{name:', '}]']);
  scan(/case"([A-Z][A-Z0-9_]+)":return\{/g, ['case"', '};', '}}', 'default:']);
  for (const m of bundle.matchAll(new RegExp(String.raw`(MENU_\w+):\{(?:[^{}]|\{[^{}]*\})*?${LABEL}`, 'g'))) {
    if (!out.has(m[1]!)) out.set(m[1]!, m[2]!);
  }
  return out;
}

const title = (id: string) => id.replace(/^(COMMAND|MENU|DOCUMENT|CONTEXT)_(CONTAINER_)?/, '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function vivaldiMenusToRc(main: Node[], context: Node[], labels: Map<string, string>, header: string[]): { text: string; items: number } {
  const lines = header.map((h) => `# ${h}`);
  let items = 0;
  const label = (id: string) => labels.get(id) ?? title(id);
  const walk = (nodes: Node[], depth: number) => {
    const pad = '    '.repeat(depth);
    for (const n of nodes) {
      if (n.type === 'separator' || n.type === 'control') continue;
      if (n.type === 'container') { lines.push(`${pad}// dynamic list: ${rc(n.action ?? '')}`); continue; }
      if (n.children) {
        lines.push(`${pad}POPUP "${rc(label(n.action ?? n.name ?? '')) || '(untitled)'}"`, `${pad}{`);
        walk(n.children, depth + 1);
        lines.push(`${pad}}`);
        continue;
      }
      if (!n.action || !/^\w+$/.test(n.action)) continue;
      lines.push(`${pad}MENUITEM "${rc(label(n.action))}", ${n.action}`);
      items++;
    }
  };
  lines.push('', 'VIVALDI_MAIN MENU', '{');
  for (const top of main) if (top.children) walk(top.children, 1);
  lines.push('}', '', 'VIVALDI_CONTEXT MENU', '{');
  for (const menu of context) {
    if (!menu.children) continue;
    lines.push(`    POPUP "Context menu: ${rc(menu.action ?? '')}"`, '    {');
    walk(menu.children, 2);
    lines.push('    }');
  }
  lines.push('}', '');
  return { text: lines.join('\n'), items };
}
