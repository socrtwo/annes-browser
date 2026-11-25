import type { GopherItem, GopherRequest } from './parse.ts';

/** Escape text for HTML element content and double-quoted attributes. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Policy for every page the browser generates from Gopher data: no scripts,
 * no plugins, no network access except submitting a Gopher search form, and an
 * opaque origin. Server data is also escaped; this is the second layer.
 */
export const GOPHER_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action gopher:; base-uri 'none'; sandbox allow-forms";

/** Policy for HTML documents served over Gopher: rendered, but inert. */
export const GOPHER_HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; sandbox";

const STYLE = `
body{font:14px/1.45 ui-monospace,Menlo,Consolas,monospace;margin:1.5rem;color:#1a1a1a;background:#fbfaf6}
h1{font-size:1rem;margin:0 0 1rem;border-bottom:1px solid #c9c5b8;padding-bottom:.5rem}
.r{display:flex;gap:.75rem;white-space:pre-wrap}.t{flex:0 0 3.5rem;color:#77705f;text-align:right}
a{color:#0b4f9c}.e{color:#a11}.n{color:#77705f}
@media (prefers-color-scheme:dark){body{color:#e6e3da;background:#1b1a17}h1{border-color:#4a473f}a{color:#8fc1ff}.t,.n{color:#9a9482}.e{color:#ff8a8a}}
`.trim();

const TYPE_LABELS: Record<string, string> = {
  '0': 'text', '1': 'menu', '4': 'binhex', '5': 'archive', '6': 'uue', '7': 'search', '9': 'binary',
  g: 'gif', I: 'image', p: 'png', h: 'html', s: 'sound', d: 'doc', ';': 'video', '<': 'sound', '3': 'error',
};

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

function rows(items: readonly GopherItem[]): string {
  return items
    .map((it) => {
      const label = it.type === 'i' ? '' : (TYPE_LABELS[it.type] ?? it.type);
      const text = escapeHtml(it.display) || '&nbsp;';
      let cell: string;
      if (it.href) cell = `<a href="${escapeHtml(it.href)}">${text}</a>`;
      else if (it.type === '3') cell = `<span class="e">${text}</span>`;
      else if (it.note) cell = `<span>${text} <span class="n">(${escapeHtml(it.note)})</span></span>`;
      else cell = `<span>${text}</span>`;
      return `<div class="r"><span class="t">${escapeHtml(label)}</span>${cell}</div>`;
    })
    .join('\n');
}

export function gopherTitle(req: GopherRequest): string {
  const sel = Buffer.from(req.selector).toString('latin1');
  return `gopher://${req.host}${req.port === 70 ? '' : `:${req.port}`}${sel ? ` ${sel}` : ''}`;
}

export function renderMenu(req: GopherRequest, items: readonly GopherItem[]): string {
  return page(gopherTitle(req), rows(items));
}

/** Search page for a type-7 item: a form before any query, results after. */
export function renderSearch(req: GopherRequest, actionUrl: string, items?: readonly GopherItem[]): string {
  const form = `<form method="get" action="${escapeHtml(actionUrl)}"><label>Search: <input name="q" autofocus size="40"></label> <button>Search</button></form>`;
  return page(gopherTitle(req), form + (items ? `<p></p>${rows(items)}` : ''));
}

export function renderError(title: string, message: string): string {
  return page(title, `<p class="e">${escapeHtml(message)}</p>`);
}
