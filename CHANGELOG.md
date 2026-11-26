# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Added
- 2026-11-26: Census sources for closed-source browsers, indirectly.
  - Wine's re-creation of Internet Explorer's main menu (`ieframe.rc`, 13 items), read by a new Windows resource-script extractor.
  - Safari's page context menu from WebKit, Apple's open engine: the 2010 tag (Safari 5, 54 items) and current (61 items), read by a new extractor for WebKit's localized strings.
  - Two Wikimedia Commons screenshots (Netscape 0.92 and Communicator 4.8) transcribed by hand from the image into `catalog/census/transcriptions/`, each with the image address and hash, as a new lineage kind, "screenshot".
  - 11 new canonical commands (305 in all), e.g. What's Related, Look Up, Speak, Search the page, Copy link to highlight.
  - 5 new unit tests.
- 2026-11-26: Census from scanned manuals. Three Netscape manuals at the Internet Archive (Navigator 1.1, 3.0; Communicator 4.5) read by fixed phrasings, 58 items, each reviewed in context: 28 linked as "manual" history, 16 rejected with reasons (other programs' menus, OCR errors).
- 2026-11-26: Command census (Phase 1, first pass).
  - Menu definitions and command tables read from 23 versions of 16 open-source browsers (Mosaic, Lynx, w3m, ELinks, Dillo, Chrome and Chromium, Brave, SeaMonkey, Firefox, Falkon, Ladybird, Konqueror, Otter, Vimium, qutebrowser), each pinned to a commit with a hash, 2,750 items in all.
  - `npm run census:verify` re-reads every source and checks every cited line; CI runs it as a non-blocking job.
  - 220 new canonical commands (294 in all), with a history attached to each from the census: browser, version, menu path, and a link to the exact source line.
  - Hand-written history kept but marked "unverified".
  - Menu Archaeology shows per-browser histories; each command has its own page with source links.
  - The command palette ranks built commands first and marks unbuilt ones "planned".
  - Reports: `docs/CENSUS.md` and the work queue `docs/census-unlinked.tsv`.
  - 36 new unit tests and 8 new end-to-end checks.
- 2026-11-26: Phase 3, first set.
  - Settings store (layout, keymap, home page, search engine), saved atomically; invalid or corrupt files never break startup.
  - Find in page with match count, next and previous.
  - Bookmarks: star button, Bookmark This Page, searchable panel, entries listed in the Bookmarks menu.
  - History: recorded per visit, searchable panel, delete entries.
  - Downloads panel: progress, open, show in folder, cancel, clear; warning before saving files that can run programs.
  - Private windows with their own in-memory session each.
  - Permission prompts naming the requesting site; camera and microphone decided separately.
  - Page Info with connection, certificate, permissions and cookie count.
  - Clear Browsing Data (history only, or everything).
  - Context menus for pages, links, images, selections and text fields, including spelling suggestions.
  - Save Page As (complete HTML or single-file MHTML), Save Link As, Save Image As, Use Current Page as Home Page.
  - 29 new commands; 25 new unit tests; 59 new end-to-end checks.
- 2026-11-25: Phase 2 foundation.
  - Command catalog compiled from YAML, with schema and cross-reference validation.
  - Command registry: one execution path with platform, capability, argument and enablement checks.
  - Context expressions, layered keymaps, multi-key sequences, modal keyboard mode.
  - Menu layouts (Modern, 1994 Minimal, 1999 Suite, generated Everything) and command palette.
  - Electron shell: tabs, separate UI and web sessions, sandboxed renderers, validated IPC.
  - Navigation, network-destination, permission, download and startup policies.
  - Built-in Gopher client rendered as script-free pages.
  - Flash emulation through Ruffle, per-tab opt-in.
  - 66 unit tests, 46 end-to-end checks, CI workflow.
  - Architecture, security model, decisions, integrations and handoff documents.
- 2026-11-24: Project metadata: README, ROADMAP, COST-ESTIMATE, command-catalog schema, contributing guide, issue template. No application code yet.
