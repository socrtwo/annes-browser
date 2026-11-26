/**
 * Fetch source files from GitHub at an exact commit, with a local cache.
 *
 * Every census source is pinned to a commit SHA, so a citation (repo, commit,
 * path, line) can be re-checked at any time. Raw file hosts rate-limit, so
 * requests are spaced out and retried on 429 and 5xx.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE_DIR = join(root, '.cache', 'census');

export interface SourceFile {
  repo: string; // owner/name
  commit: string; // 40-hex SHA
  path: string;
}

export const rawUrl = (s: SourceFile) => `https://raw.githubusercontent.com/${s.repo}/${s.commit}/${s.path}`;
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export type Fetcher = (url: string) => Promise<{ status: number; text: string }>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;

export const httpFetch: Fetcher = async (url) => {
  // At most about 3 requests a second, whatever the caller does.
  const wait = lastRequest + 350 - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': 'annes-browser-census' } });
  // Decode as latin1 when the file is not valid UTF-8, so old files still have stable line contents.
  const bytes = Buffer.from(await res.arrayBuffer());
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = bytes.toString('latin1'); }
  return { status: res.status, text };
};

/** Read a pinned file, from the cache if present. Retries rate limits; fails on anything else. */
export async function getSource(s: SourceFile, fetcher: Fetcher = httpFetch): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(s.commit)) throw new Error(`${s.repo}: "${s.commit}" is not a full commit SHA`);
  const cachePath = join(CACHE_DIR, s.repo.replace('/', '_'), s.commit, s.path.replace(/\//g, '__'));
  if (existsSync(cachePath)) return readFileSync(cachePath, 'utf8');
  const url = rawUrl(s);
  let delay = 2000;
  for (let attempt = 0; attempt < 6; attempt++) {
    const { status, text } = await fetcher(url);
    if (status === 200) {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, text);
      return text;
    }
    if (status === 429 || status >= 500) { await sleep(delay); delay *= 2; continue; }
    throw new Error(`${url}: HTTP ${status}`);
  }
  throw new Error(`${url}: still rate limited after retries`);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const unescapeHtml = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

export const archiveUrl = (item: string, file: string) => `https://archive.org/stream/${item}/${file}`;

/**
 * Read the OCR text of an Internet Archive item. The archive serves it inside a web page; the text
 * is the page's single <pre> block. There is no commit to pin to, so the census file records the
 * text's hash and `census verify` reports if the archive ever re-derives it.
 */
export async function getArchiveText(item: string, file: string, fetcher: Fetcher = httpFetch): Promise<string> {
  if (!/^[A-Za-z0-9][\w-]*(?:\.[\w-]+)*$/.test(item) || !/^[A-Za-z0-9][\w%-]*(?:\.[\w%-]+)*_djvu\.txt$/.test(file)) throw new Error(`not an archive text file: ${item}/${file}`);
  const cachePath = join(CACHE_DIR, 'archive.org', item, file);
  if (existsSync(cachePath)) return readFileSync(cachePath, 'utf8');
  let delay = 5000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { status, text } = await fetcher(archiveUrl(item, file));
    if (status === 200) {
      const pre = /<pre>([\s\S]*?)<\/pre>/.exec(text);
      if (!pre) throw new Error(`${item}/${file}: no text block in the page (the item may be restricted)`);
      const out = unescapeHtml(pre[1]!);
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, out);
      return out;
    }
    if (status === 429 || status >= 500) { await sleep(delay); delay *= 2; continue; }
    throw new Error(`${archiveUrl(item, file)}: HTTP ${status}`);
  }
  throw new Error(`${archiveUrl(item, file)}: still rate limited after retries`);
}

/** Resolve a branch or tag to the commit it points at (annotated tags are peeled). */
export function resolveRef(repo: string, ref: string): string {
  const out = execFileSync('git', ['ls-remote', `https://github.com/${repo}`, ref, `${ref}^{}`], { encoding: 'utf8', timeout: 120_000 });
  const lines = out.trim().split('\n').filter(Boolean).map((l) => l.split('\t') as [string, string]);
  const peeled = lines.find(([, r]) => r.endsWith('^{}'));
  const sha = (peeled ?? lines.find(([, r]) => r === `refs/tags/${ref}` || r === `refs/heads/${ref}` || r === ref) ?? lines[0])?.[0];
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`cannot resolve ${repo} ${ref}`);
  return sha;
}
