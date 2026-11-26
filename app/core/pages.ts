import type { CommandRecord, Lineage } from './catalog/types.ts';
import { escapeHtml } from './gopher/render.ts';

/**
 * Internal pages served at anne://pages/. They are static HTML with no
 * script, shown in ordinary tabs under a policy that forbids everything
 * except their own inline style.
 */

export const INTERNAL_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox";

const STYLE = `
body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.25rem;color:#1c1b18;background:#fbfaf6}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.05rem;margin:2rem 0 .5rem}p{margin:.6rem 0}
a{color:#0b4f9c}small,.m{color:#6d675a}code{font:13px ui-monospace,Menlo,Consolas,monospace}
table{border-collapse:collapse;width:100%;font-size:.9rem}td,th{text-align:left;padding:.35rem .6rem .35rem 0;border-bottom:1px solid #dedacd;vertical-align:top}
.tag{display:inline-block;font-size:.72rem;padding:.05rem .4rem;border:1px solid #b9b4a4;border-radius:3px;color:#6d675a}
@media (prefers-color-scheme:dark){body{color:#e8e5dc;background:#1b1a17}a{color:#8fc1ff}small,.m,.tag{color:#a39d8c}td,th{border-color:#3a382f}.tag{border-color:#57534a}}
`.trim();

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

/**
 * `owner/repo@commit:path#Lnn` as a GitHub address, or undefined if the text is not in that form.
 * Only github.com addresses are produced, so a malformed or hostile `ref` cannot become another link.
 */
export function refUrl(ref: string): string | undefined {
  // A scanned manual at the Internet Archive. Its text page has no line anchors, so the link opens the text.
  // Menus dumped from a program held by the Internet Archive: link to the item the program came from.
  const dump = /^dump\/([A-Za-z0-9][\w-]*(?:\.[\w-]+)*)\/[a-z0-9][a-z0-9.-]*\.txt#L\d+$/.exec(ref);
  if (dump) return `https://archive.org/details/${dump[1]}`;
  // A screenshot transcribed from Wikimedia Commons: link to the file's description page.
  const shot = /^commons\/([A-Za-z0-9][\w.(),-]*\.(?:png|jpe?g|gif|webp))#L\d+$/.exec(ref);
  if (shot) return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(shot[1]!)}`;
  const scan = /^archive\.org\/([A-Za-z0-9][\w-]*(?:\.[\w-]+)*)\/([A-Za-z0-9][\w%-]*(?:\.[\w%-]+)*_djvu\.txt)#L\d+$/.exec(ref);
  if (scan) return `https://archive.org/stream/${scan[1]}/${scan[2]}`;
  const m = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{7,40}):([\w./+~@ -]+)#L(\d+)$/.exec(ref);
  return m ? `https://github.com/${m[1]}/blob/${m[2]}/${m[3]!.split('/').map(encodeURIComponent).join('/')}#L${m[4]}` : undefined;
}

/** One line per browser: `Google Chrome 3.0.195.25 (2009), 10.0.648.204 (2011); Lynx 2.7.1 (1996)`. */
export function lineageSummary(lineage: readonly Lineage[]): string {
  const byBrowser = new Map<string, string[]>();
  for (const l of lineage) {
    const part = `${l.versions && l.versions !== 'development snapshot' ? `${l.versions} ` : 'now '}${l.year ? `(${l.year})` : ''}${l.source === 'recalled' ? ' unverified' : ''}`.trim();
    const list = byBrowser.get(l.browser) ?? [];
    if (!list.includes(part)) list.push(part);
    byBrowser.set(l.browser, list);
  }
  return [...byBrowser].map(([b, v]) => `${b} ${v.join(', ')}`).join('; ');
}

function lineageRows(c: CommandRecord): string {
  return (c.lineage ?? [])
    .map((l) => {
      const href = l.ref ? refUrl(l.ref) : undefined;
      const line = l.source === 'manual' ? ` <small>manual, line ${escapeHtml(/#L(\d+)$/.exec(l.ref ?? '')?.[1] ?? '?')}</small>`
        : l.source === 'screenshot' ? ' <small>screenshot</small>' : '';
      const evidence = href ? `<a href="${escapeHtml(href)}">${escapeHtml(l.key ?? 'source')}</a>${line}` : l.source === 'recalled' ? '<span class="tag">unverified</span>' : '';
      return `<tr><td>${escapeHtml(l.browser)}${l.versions ? ` ${escapeHtml(l.versions)}` : ''}</td><td>${escapeHtml(l.menu ?? '')}</td><td>${l.year ?? ''}</td><td>${evidence}</td></tr>`;
    })
    .join('');
}

export function homePage(): string {
  return page("Anne's Browser", `<h1>Anne's Browser</h1><p class="m">Every menu command from 35 years of web browsers.</p>
<p>Type an address or a search above. Press <code>F2</code> to search all commands.</p>
<h2>Places to start</h2>
<p><a href="anne://pages/archaeology">Menu archaeology</a>: every command and where it came from.<br>
<a href="gopher://gopher.floodgap.com/">Gopher</a>: the pre-web internet, through the built-in client.<br>
<a href="anne://pages/about">About</a></p>`);
}

export function aboutPage(version: string, engine: string): string {
  return page("About Anne's Browser", `<h1>Anne's Browser</h1><p class="m">Version ${escapeHtml(version)}</p>
<p>Engine: ${escapeHtml(engine)}</p><p>MIT License. No telemetry.</p><p><a href="anne://pages/home">Home</a></p>`);
}

export function stubPage(c: CommandRecord | undefined): string {
  if (!c) return page('Unknown command', '<h1>Unknown command</h1><p><a href="anne://pages/home">Home</a></p>');
  const lineage = lineageRows(c);
  return page(c.label, `<h1>${escapeHtml(c.label)}</h1><p class="m">${escapeHtml(c.description)}</p>
<h2>Why this is not available</h2><p>${escapeHtml(c.status_reason ?? 'This feature has been retired.')}</p>
${lineage ? `<h2>Where it came from</h2><table><tr><th>Browser</th><th>Menu</th><th>Year</th><th>Source</th></tr>${lineage}</table>` : ''}
<p><a href="anne://pages/archaeology">All commands</a></p>`);
}

/** The page for one command: what it does, its status, and every source that offered it. */
export function commandPage(c: CommandRecord | undefined): string {
  if (!c) return notFoundPage();
  const lineage = lineageRows(c);
  const status = c.status === 'implement' ? '' : ` <span class="tag">${escapeHtml(c.status)}</span>`;
  return page(c.label, `<h1>${escapeHtml(c.label)}${status}</h1><p class="m"><code>${escapeHtml(c.id)}</code></p>
<p>${escapeHtml(c.description)}</p>
${c.status_reason ? `<p><small>${escapeHtml(c.status_reason)}</small></p>` : ''}
${c.aliases?.length ? `<p><small>Also known as: ${c.aliases.map(escapeHtml).join(', ')}</small></p>` : ''}
${lineage ? `<h2>Where it came from</h2><table><tr><th>Browser</th><th>Menu</th><th>Year</th><th>Source</th></tr>${lineage}</table>
<p><small>"Source" links to the line in the browser's own source code, to the scanned text of a manual (read by OCR, so spelling may be imperfect), or to a screenshot the entry was transcribed from. Entries marked unverified were written from memory.</small></p>` : '<p><small>No history recorded yet.</small></p>'}
<p><a href="anne://pages/archaeology">All commands</a></p>`);
}

export function archaeologyPage(commands: readonly CommandRecord[]): string {
  const sourced = commands.filter((c) => (c.lineage ?? []).some((l) => l.source === 'census' || l.source === 'manual' || l.source === 'screenshot')).length;
  const rows = [...commands]
    .sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label))
    .map((c) => {
      const origins = escapeHtml(lineageSummary(c.lineage ?? []));
      const tag = c.status === 'implement' ? '' : ` <span class="tag">${c.status}</span>`;
      return `<tr><td><a href="anne://pages/command?id=${encodeURIComponent(c.id)}">${escapeHtml(c.label)}</a>${tag}<br><small><code>${escapeHtml(c.id)}</code></small></td><td>${escapeHtml(c.description)}</td><td><small>${origins}</small></td></tr>`;
    })
    .join('');
  return page('Menu archaeology', `<h1>Menu archaeology</h1><p class="m">${commands.length} commands; ${sourced} have a history read from browser source code or manuals. Choose a command to see the exact lines. "Unverified" entries were written from memory.</p>
<table><tr><th>Command</th><th>What it does</th><th>Seen in</th></tr>${rows}</table>`);
}

export function blockedPage(url: string, reason: string): string {
  return page('Page not opened', `<h1>Page not opened</h1><p>${escapeHtml(reason)}</p><p><code>${escapeHtml(url.slice(0, 500))}</code></p>`);
}

export function notFoundPage(): string {
  return page('Not found', '<h1>Not found</h1><p><a href="anne://pages/home">Home</a></p>');
}
