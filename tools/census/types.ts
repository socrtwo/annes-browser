/**
 * Command census data model.
 *
 * A census file records what one browser version offered, as read from its
 * own source code at an exact commit. Nothing in it is from memory: every
 * item carries the line it came from and the text found there, and the file
 * records a hash of the source, so `npm run census:verify` can re-check it.
 */

export type ExtractorId =
  | 'mosaic-menu' | 'lynx-keymap' | 'w3m-func' | 'elinks-actions' | 'chromium-ids' | 'dillo-menu' | 'xul-menu'
  | 'firefox-menu' | 'falkon-actions' | 'qt-actions' | 'otter-enum' | 'vimium-commands' | 'qutebrowser-commands'
  | 'konqueror-rc' | 'brave-ids' | 'qt-ui';

export interface SourceFileSpec {
  path: string;
  /** What the file is for, e.g. "menu definitions" or "label strings". */
  role: 'primary' | 'labels';
}

/** One entry in catalog/census/sources.yaml. */
export interface SourceSpec {
  /** Census file name: `<id>.yaml`. */
  id: string;
  browser: string;
  version: string;
  /** Year this version was released. Not derived from the source: common knowledge, checked against release notes. */
  released: number;
  platform: string;
  repo: string;
  /** Branch or tag the commit was resolved from, for humans. */
  ref: string;
  /** Full commit SHA. Filled in by `census pin`. */
  commit?: string;
  extractor: ExtractorId;
  files: SourceFileSpec[];
}

export interface CensusItem {
  /** Identifier inside the source: an enum name, menu id, action name or similar. */
  key: string;
  /** Label as a user sees it, with accelerator markers removed. */
  label?: string;
  /** The source's own short description of the command, at most 100 characters. */
  note?: string;
  /** Menu path, e.g. `File` or `File > New`. */
  menu?: string;
  /** Section or group in the source, when it has one (Chromium comment sections, Vimium groups). */
  group?: string;
  shortcut?: string;
  /** 1-based line in the primary source file. */
  line: number;
  /** Text found on that line (trimmed, at most 120 characters). */
  evidence: string;
  /** File the line is in, when it is not the first file listed. */
  file?: string;
}

export interface CensusFile {
  version: 1;
  id: string;
  browser: string;
  browser_version: string;
  released: number;
  platform: string;
  source: {
    repo: string;
    ref: string;
    commit: string;
    extractor: ExtractorId;
    files: { path: string; sha256: string; lines: number; role: 'primary' | 'labels' }[];
    retrieved: string;
  };
  items: CensusItem[];
}

/** What an extractor is given: the text of each file, by path. */
export type Files = Readonly<Record<string, string>>;

export type Extractor = (files: Files, spec: SourceSpec) => CensusItem[];
