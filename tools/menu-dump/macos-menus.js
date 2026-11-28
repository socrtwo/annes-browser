#!/usr/bin/osascript -l JavaScript
/*
 * Dump a running macOS application's menu bar as a census transcription.
 *
 *   osascript -l JavaScript tools/menu-dump/macos-menus.js Safari > safari-18.1-macos-menus.txt
 *
 * Needs: the app running, and Accessibility permission for the terminal that runs this
 * (System Settings > Privacy & Security > Accessibility). Nothing is clicked: menus are
 * read through System Events.
 *
 * Output: one line per command, `<menu path> | <label> | <shortcut>`. Menus that list the
 * user's own things (history, bookmarks, windows, profiles, recent files) are written with
 * every item after their first separator commented out as `#? `: those are usually page
 * titles, not commands. Review them and remove `#? ` only from real commands before adding
 * the file to catalog/census/transcriptions/.
 */
ObjC.import('Foundation');

const PERSONAL = /^(History|Bookmarks|Favorites|Window|Profiles?|Open Recent|Recently Closed|Recently Visited|Tab Groups|Develop|Workspaces)$/i;

function shortcut(mi) {
  let ch = '';
  let mods = 0;
  try { ch = mi.attributes.byName('AXMenuItemCmdChar').value() || ''; } catch (e) { return ''; }
  if (!ch) return '';
  try { mods = mi.attributes.byName('AXMenuItemCmdModifiers').value() || 0; } catch (e) { mods = 0; }
  const keys = [];
  if (mods & 4) keys.push('Ctrl');
  if (mods & 2) keys.push('Opt');
  if (mods & 1) keys.push('Shift');
  if (mods & 16) keys.push('Fn');
  if (!(mods & 8)) keys.push('Cmd');
  const named = { '\u001b': 'Esc', '\r': 'Return', '\t': 'Tab', ' ': 'Space', '\u007f': 'Delete', '\b': 'Backspace' };
  keys.push(named[ch] || ch.toUpperCase());
  return keys.join('+');
}

const clean = (s) => String(s).replace(/\|/g, '/').replace(/[\u0000-\u001f]/g, ' ').trim();

function walk(menu, path, personal, out) {
  let afterSeparator = false;
  for (const mi of menu.menuItems()) {
    let title = '';
    try { title = mi.name() || ''; } catch (e) { title = ''; }
    if (!title) { afterSeparator = true; continue; }
    const hide = personal && afterSeparator;
    let sub = [];
    try { sub = mi.menus(); } catch (e) { sub = []; }
    if (sub.length) {
      walk(sub[0], `${path} > ${clean(title)}`, personal || PERSONAL.test(title), out);
      continue;
    }
    const sc = shortcut(mi);
    out.push(`${hide ? '#? ' : ''}${path} | ${clean(title)}${sc ? ` | ${sc}` : ''}`);
  }
}

function run(argv) {
  const name = argv[0];
  if (!name) return 'usage: osascript -l JavaScript macos-menus.js <Application name>';
  const se = Application('System Events');
  const proc = se.processes.byName(name);
  if (!proc.exists()) return `${name} is not running`;
  let version = '';
  try { version = Application(name).version(); } catch (e) { version = 'unknown'; }
  const os = ObjC.unwrap($.NSProcessInfo.processInfo.operatingSystemVersionString);
  const out = [
    `# Menus read from ${name} ${version} on macOS (${os}) by tools/menu-dump/macos-menus.js, through System Events.`,
    `# read: ${new Date().toISOString().slice(0, 10)}`,
    '# Each line: menu path | label | shortcut. Lines starting "#? " came from menus that list personal items; review them.',
  ];
  const items = proc.menuBars[0].menuBarItems();
  items.forEach((top, i) => {
    if (i === 0) return; // the Apple menu belongs to the system, not the app
    const title = clean(top.name() || '');
    let menus = [];
    try { menus = top.menus(); } catch (e) { menus = []; }
    if (menus.length) walk(menus[0], title, PERSONAL.test(title), out);
  });
  return out.join('\n');
}
