# Decisions

Each entry: the decision, its status, and what it would cost to reverse.

**Status values.** *Adopted*: the code is built on it. *Proposed*: recommended, nothing depends on it yet. *Owner*: only the project owner can decide.

## Roadmap decisions (D1–D8)

| # | Decision | Status | Notes |
|---|---|---|---|
| D1 | Desktop first, Android second | **Adopted** | The Phase 2 shell is desktop. Reversal cost: none yet for Android; `app/core` is platform-neutral |
| D2 | Electron (Chromium) on desktop | **Adopted** | Everything in `app/main` is Electron-specific (about 1,000 lines). `app/core` (about 2,000 lines) would survive a change of engine |
| D3 | GeckoView on Android | Proposed | Nothing built |
| D4 | TypeScript on desktop; Kotlin on Android | **Adopted** (TypeScript) | Kotlin side is proposed |
| D5 | License | **Owner** | MIT placeholder in `LICENSE`. Ruffle is MIT or Apache-2.0, compatible with either MIT or MPL-2.0 |
| D6 | Name clearance for "Anne's Browser" | **Owner** | Not done. Needed before a public release |
| D7 | Distribution channels | Proposed | GitHub Releases first; decide at Phase 10 |
| D8 | Extension support | Proposed, narrowed | Electron's extension API is partial. See ARCHITECTURE.md, "Decisions still open" |

D2 and D4 were adopted by building on them, following the roadmap's recommendation. If either is wrong, say so before Phase 3 starts; after that the cost rises with every handler written.

## Architecture decisions made in Phase 2

| # | Decision | Why | Cost to reverse |
|---|---|---|---|
| A1 | One execution path for all commands (`CommandRegistry.execute`) | Checks cannot be skipped by a new entry point | High: everything assumes it |
| A2 | Menu layouts are separate files, not fields on each command | A layout needs order, separators and submenus; per-command `menu_path` cannot express them | Low |
| A3 | "Everything" layout is generated from categories | New commands appear in a menu with no layout edit | Low |
| A4 | Keys are handled in the main process, before the page | Pages cannot block or spy on shortcuts; one dispatcher for all views | Medium |
| A5 | Plain typing keys bind only in modal mode (build-time rule) | Typing must never trigger commands by accident | Low, but do not |
| A6 | Two sessions: UI and web, with separate protocol handlers | A page cannot address UI resources at all | High |
| A7 | Tabs have no preload script | No bridge to attack | Medium: features needing page access must go through `executeJavaScript` or the DevTools protocol from main, each reviewed |
| A8 | Internal pages are script-free HTML in ordinary tabs | They need no privileges, so they get none | Low. A page that needs interaction (settings) should be built in the UI view instead, not by adding script to `anne://pages` |
| A9 | Gopher (and later FTP, NNTP) are unregistered schemes | Chromium drops ports from custom standard schemes | Low |
| A10 | Legacy protocol clients live in `app/core` and return a plain response object | Testable without Electron; one shared network policy | Low |
| A11 | Flash emulation is per-tab opt-in, files gated by tab | Limits exposure and fingerprinting | Low |
| A12 | The catalog is compiled and validated at build time; the runtime trusts it | No YAML parser or schema validator in the shipped app | Low |
| A13 | Context keys are a closed list | A typo in a `when` expression is a build error, not a silently dead command | Low |
| A14 | Code uses only erasable TypeScript syntax | Tools and tests run on Node directly with no compile step | Low |

## Decisions made in Phase 3 (first session)

| # | Decision | Why | Cost to reverse |
|---|---|---|---|
| B1 | Settings, bookmarks and history are JSON files with atomic writes, not a database | Small data; easy to inspect and back up; no native module to package | Low: the stores hide the format |
| B2 | Bookmarks and history share one model (`UrlStore`) | Same shape and operations; one set of tests | Low |
| B3 | List panels (bookmarks, history, downloads) are overlays in the UI view | They need interaction; internal pages stay script-free (A8) | Medium |
| B4 | The UI may read only the list panel that is open | Limits what a compromised UI can read in one step | Low |
| B5 | Permission prompts, Page Info, Clear Browsing Data and download warnings use native dialogs | Drawn by the main process, so page content cannot imitate or overlay them | Low: a styled prompt in the UI view is possible later, under the same origin rule |
| B6 | Permission answers are kept for the session only | No settings UI to review or revoke saved answers yet | Low |
| B7 | Each private window gets its own in-memory partition | Private windows do not share state with each other either | Low |
| B8 | The download list is in memory only | Simpler; Chrome-style persistence can come later | Low |
| B9 | Menu items that need arguments are generated in code, never placed in layout files (build-time rule) | A layout cannot supply arguments; the palette also hides such commands | Low |
| B10 | Tabs that pages ask for (pop-ups, Open Link) are created only if the address is allowed | No empty tabs from refused requests; also prevented a Save Page hang | Low |

## Deviations from the Phase 0 documents

- `docs/COMMAND-CATALOG.md` originally put `shortcuts`, `layouts` and `menu_path` on each command record. They moved to keymap and layout files (A2). The document has been updated.
- The roadmap listed Ruffle and Gopher under Phase 6. Both were built now, because they set the security pattern every other legacy integration follows.
