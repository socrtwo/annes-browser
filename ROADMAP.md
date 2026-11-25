# Anne's Browser: Roadmap

Last updated: 2026-11-24. Status: Phase 0.

Token figures per phase are output-token budgets for AI-assisted development at the mid estimate (see [COST-ESTIMATE.md](COST-ESTIMATE.md)). Input and cache tokens scale with them at about 50:1.

---

## Phase 0: Decisions and metadata *(this commit)*

**Deliverables:** README, ROADMAP, COST-ESTIMATE, CHANGELOG, CONTRIBUTING, LICENSE, command-catalog schema, issue template.

**Open decisions (must close before Phase 2):**

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Primary platform | Desktop first / Android first / both at once | Desktop first. Menu-heavy UI suits desktop, and Android follows using the same registry. |
| D2 | Engine (desktop) | Electron (Chromium) / CEF + native / Qt WebEngine / Tauri (system WebView) | **Electron.** Full Chromium, extension support, DevTools and cross-platform menus. Tauri's system WebView varies too much between OSes. |
| D3 | Engine (Android) | GeckoView / Android System WebView / Chromium fork | **GeckoView.** Real extension support, about: pages and full control. System WebView is too limited for this feature set. |
| D4 | Language | TypeScript (desktop) + Kotlin (Android) | TypeScript and Kotlin, with the command registry shared as YAML/JSON. |
| D5 | License | MIT / MPL-2.0 / GPL-3.0 | MIT for maximum reuse, or MPL-2.0 for file-level copyleft. Currently MIT placeholder. |
| D6 | Name clearance | Trademark search for "Anne's Browser" | Run a USPTO/EUIPO search before any public release. |
| D7 | Distribution | GitHub Releases / F-Droid / Play Store / winget / Homebrew / Flathub | GitHub Releases first, then F-Droid and Flathub. |
| D8 | Extensions | Chrome Web Store (MV3) / Firefox AMO / none | MV3 on desktop and AMO on Android, following the engines. |

**Exit criteria:** D1–D8 recorded in `docs/DECISIONS.md`.

---

## Phase 1: Command census *(~0.4M output tokens)*

Build the master catalog that the whole product is generated from.

1. For each surveyed browser and major version, list every menu, context-menu, toolbar, keyboard-only and settings-exposed command. Sources: manuals, help files, archived screenshots (Internet Archive, Toastytech GUI gallery), menu dumps of installable versions in VMs, and source code where it is available (Mozilla, Chromium, WebKit, Konqueror, Lynx, Dillo).
2. Record each one in `catalog/sources/<browser>-<version>.yaml`.
3. De-duplicate into `catalog/commands.yaml`, one canonical record per behavior, with aliases and lineage (schema in [docs/COMMAND-CATALOG.md](docs/COMMAND-CATALOG.md)).
4. Classify each one: `implement` / `emulate` / `stub` / `omit`, with a reason for each.

**Expected size:** about 2,000–3,000 raw entries, reducing to about 700–1,000 canonical commands.

**Exit criteria:** catalog validates against the schema. Every surveyed browser has a source file, and every canonical command has a classification.

---

## Phase 2: Architecture skeleton *(~0.6M)*

- App shell: windows, tab strip, address bar, status bar, sidebar host.
- **Command registry runtime:** loads `commands.yaml` and exposes `execute(id, args)`, `isEnabled(id, ctx)` and `isChecked(id, ctx)`.
- **Menu generator:** builds native menu bars and context menus from the registry, with era-layout definitions as data.
- **Command palette:** fuzzy search across labels, aliases and lineage ("Netscape 4: Edit Page").
- **Keybinding engine:** profiles (Modern, Classic IE, Classic Netscape, Opera, Emacs, vi), conflict detection and a chord editor.
- Settings store, profiles and an import pipeline (bookmarks, history and passwords from other browsers).
- Test harness: every registry command has at least a smoke test, or an explicit `stub` assertion.

**Exit criteria:** a browser that opens pages in tabs, with menus and palette generated entirely from the registry.

---

## Phase 3: Modern baseline parity *(~1.0M)*

The commands every current browser has: navigation, tabs and windows, reopen closed, pin, mute, bookmarks manager, history, downloads, find in page, zoom, print and print preview, page info, view source, DevTools, private windows, site permissions, cookies and storage manager, password manager, autofill, reader mode, translate hook, PDF viewer, spell-check, sync stub, task manager, extensions manager, default-browser and handler settings.

**Exit criteria:** passes a scripted parity checklist against current Chrome and Firefox menus.

---

## Phase 4: Era layouts and personalities *(~0.4M)*

- Menu layouts as data: *1994 Minimal* (File/Edit/View/Go/Bookmarks/Options/Directory/Help), *1999 Suite* (Communicator-style with Tasks and Window menus), *2001 Classic* (IE6-style Favorites/Tools), *2005 Power* (Opera-style Tools/Widgets/Panels), *2008 Tabbed*, *2012 Hamburger*, and *Everything* (all commands, grouped).
- Toolbar presets with generic, original icons. No logos or trade dress.
- Optional status-bar and throbber behaviors (progress text, security indicator).

**Exit criteria:** switching layout changes only presentation and never availability; every command stays reachable from the palette.

---

## Phase 5: Power-user features from niche and defunct browsers *(~1.2M)*

| Origin | Commands |
|---|---|
| Opera Presto | Mouse gestures, rocker gestures, Speed Dial, Notes panel, sessions save/load, fit-to-width, user-mode/author-mode CSS toggle, "Fast Forward" (next page), cache and cookie viewers, site-specific preferences, Links panel |
| Vivaldi | Tab stacks, tab tiling, command chains, web panels, notes with screenshots, page actions, tab hibernation |
| Arc / Zen / SigmaOS | Spaces/workspaces, split view, peek/little-window, boosts (per-site CSS/JS), auto-archive tabs |
| Konqueror | Split views, file-manager mode for local and FTP/SFTP listings, KIO-style protocol handlers |
| qutebrowser / Vimium | Modal keyboard mode, hint-mode link following, `:command` line, quickmarks |
| Lynx / w3m / Links | Text-only rendering mode, numbered links, dump-as-text |
| Firefox (classic) | Containers, tab groups, about:config-style editor, Live Bookmarks (feeds), keyword bookmarks |
| IE | Favorites import/export, "Work offline", compatibility-mode user-agent switching, Accelerators (selection actions) |
| Safari | Reading List, Reader, Top Sites, Web Inspector-style responsive mode |
| Brave | Shields-style per-site blocking panel, Tor-proxied private window (via external Tor) |

**Exit criteria:** each command marked `implement` in the catalog for this phase passes its test.

---

## Phase 6: Historic and legacy emulation *(~0.7M)*

| Historic command | Treatment |
|---|---|
| Gopher, Finger, WAIS-style search | Built-in Gopher client; Finger read-only; WAIS documented as historical |
| FTP browsing | Read-only listing/download through a bundled client (engines dropped FTP) |
| Netscape Composer / FrontPage Express ("Edit Page") | Built-in WYSIWYG HTML editor with save-to-file |
| Communicator Mail, News, Address Book, IRC | Optional modules: NNTP reader, IRC client; mail opens an external client (out of scope) |
| Flash / Shockwave | Emulate through Ruffle (Flash only); Shockwave stubbed |
| Java applets, ActiveX, NPAPI plugins, VRML | **Stub with explanation** (security). VRML through an optional X3D viewer later |
| Channels / Active Desktop / Smart Update | Mapped to the feed reader and update checker; Active Desktop omitted |
| "What's Related", Directory buttons, Net Search | Re-implemented through configurable search and related-page providers |
| Character-set menu | Encoding override (still useful for old pages) |
| Show images on/off, load images manually | Implemented |

**Exit criteria:** every `emulate` and `stub` record has working behavior or an explanatory dialog.

---

## Phase 7: New commands *(~1.0M)*

New commands, prioritized for research, publishing, OCR and genealogy work:

**Archiving and history**
- *View as of…*: open the Internet Archive capture for any date; automatically offer it on 404 or 410.
- *What changed since my last visit*: visual and text diff against the locally cached copy.
- *Save as…*: single-file HTML, WARC, EPUB, PDF/A, DOCX, Markdown, plain text.
- *Recover typed text*: form-input history per site (opt-in, local, encrypted).

**Extraction**
- *OCR region / OCR image*: Tesseract-based, with language selection and copy as text.
- *Table → CSV / XLSX*, *List → CSV*.
- *Extract all links / images / media* with pattern filters and bulk download.
- *Copy as Markdown / HTML / plain*; *Copy as citation* (Chicago, MLA, APA, BibTeX, Evidence Explained style for genealogy).

**Typography and publishing**
- *Typography inspector*: fonts in use, sizes, line length, leading and contrast (WCAG).
- *Clean copy*: normalize quotes, dashes, ligatures and whitespace on copy.
- *Print designer*: margins, headers/footers, remove clutter, print selection only.

**Research workflow**
- *Research session*: highlight and annotate pages, then export notes with citations (Markdown/DOCX).
- *Side-by-side translate*: original and translation with synchronized scrolling.
- *Compare two pages* with synchronized scroll and diff.
- *Genealogy helper* (plugin): detect names, dates and places and export to a GEDCOM-ready table.

**Control and privacy**
- *Macro recorder*: record a sequence of commands and replay or bind it to a key.
- *Page network report*: trackers, third parties and data sent.
- *Undo anything*: closed tab, window, group, deleted download, cleared form.
- *Scheduled loads and page monitors*: notify on change.
- *Dead-link check* on the current page.
- *Menu archaeology*: shows each command's lineage ("first seen in Opera 7, 2003").
- *Ask the page* (opt-in, BYO API key or local model): summarize, question-answer, explain.

**Exit criteria:** each Phase 7 command is shipped behind a feature flag with docs.

---

## Phase 8: Hardening *(~0.5M)*

Accessibility (screen readers, full keyboard operation, high contrast), i18n of all command labels, performance budgets (cold start, memory per tab), security review of every emulation and protocol handler, fuzzing of the Gopher, FTP and NNTP parsers, and an auto-update channel.

---

## Phase 9: Android *(~0.8M)*

GeckoView shell. The same `commands.yaml`, filtered by `platforms`, drives a bottom-sheet command menu, palette and gestures. Termux-friendly build scripts.

---

## Phase 10: Release *(~0.2M)*

Signed builds, installers, F-Droid metadata, Flathub manifest, winget and Homebrew manifests, documentation site generated from the registry.

---

## Out of scope

- Writing a layout or JavaScript engine.
- Native execution of NPAPI, ActiveX or Java applets.
- Reproducing any vendor's logos, artwork or branded UI.
- A full email client.

## Phase budget summary

| Phase | Output tokens (mid) |
|---|---|
| 1 Census | 0.4M |
| 2 Skeleton | 0.6M |
| 3 Baseline | 1.0M |
| 4 Layouts | 0.4M |
| 5 Power features | 1.2M |
| 6 Legacy emulation | 0.7M |
| 7 New commands | 1.0M |
| 8 Hardening | 0.5M |
| 9 Android | 0.8M |
| 10 Release | 0.2M |
| **Total** | **~6.8M** (desktop-only through Phase 8: ~5.8M) |
