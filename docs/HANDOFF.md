# Handoff: what to do next, and with which model

Written at the end of the Phase 2 foundation session (2026-11-25); updated after the first Phase 3 session (2026-11-26).

## Where things stand

Built and tested: the command registry, context expressions, keymaps and key dispatch, menu building, palette search, the navigation / network / permission / download policies, a hardened Electron shell with tabs, a Gopher client, and Flash emulation through Ruffle. 45 seed commands, 3 hand-made layouts plus the generated "Everything" layout, 2 keymaps.

Verification: `npm run check` (typecheck, catalog build, 127 unit tests) and `npm run smoke` (113 end-to-end checks) pass on Linux. Not run on Windows or macOS. See the limitations in `SECURITY-MODEL.md`.

## Why the work switches model here

The decisions that are expensive to get wrong are made and enforced by code: one execution path, the session split, the navigation policy, the network policy for protocol clients, and the rule that tabs get no bridge. What remains is mostly **wide** work that follows these patterns: many command handlers, the census data, UI for existing policies. That is cheaper on Opus 5.5 at medium effort (or Sonnet 5.5 for the census), and a mistake in one handler does not spread.

## Work for Opus 5.5 (medium)

In suggested order. Each item names the pattern to copy.

1. ~~Settings store~~ **Done** (2026-11-26).
2. ~~Phase 3 commands: find, save page, bookmarks, history, downloads list, page info, private window, clear data, context menus~~ **Done** (2026-11-26). Remaining Phase 3: HTTP authentication dialog, bookmark folders and import, history grouped by day, per-site zoom memory, print preview, spell-check language choice, "remember" for permission answers across restarts.
3. ~~Permission prompt UI and download warnings~~ **Done** (2026-11-26).
4. ~~Phase 1 census~~ **First pass done** (2026-11-26): 23 browser versions, 2,750 items, 294 canonical commands, 1,238 items linked. **Remaining:** the work queue in [CENSUS.md](CENSUS.md) (1,505 items in [census-unlinked.tsv](census-unlinked.tsv)), more sources, and release-year checks. See "Continuing the census" below.
5. **Era layouts** (Phase 4): more files in `catalog/layouts/`. No code needed.
6. **FTP client.** Fully specified in INTEGRATIONS.md, including the required tests. Copy the Gopher structure.
7. **Wayback "View as of…"**, **NNTP**, **Finger**: specified in INTEGRATIONS.md.
8. **Phase 5 features** that are pure UI over the registry: sessions, notes panel, speed dial, tab stacks.

Ground rules for that work (also in CONTRIBUTING.md):

- A command gets a catalog record before any code.
- `app/core` never imports Electron.
- No preload script for tabs; no script on `anne://pages`.
- Any new URL scheme, IPC channel, `executeJavaScript` call or network client is a security change: extend `tools/smoke.ts` to cover it.
- `npm run check` and `npm run smoke` must pass before a commit.

## Work to bring back to Fable 5.2 (or a human reviewer)

| Item | Why |
|---|---|
| Password manager design and review | Credential storage and autofill origin matching; mistakes leak passwords |
| Extension support | New trust boundary; maps extension permissions to registry grants |
| Macro import format | Imported files drive commands; must stay data-only |
| Security review of each protocol client after Opus writes it | Check against the five network rules |
| Packaging: fuses, signing, auto-update verification | Supply-chain boundary |
| GeckoView bridge design (Phase 9) | Second engine, second process model |
| macOS key handling | See ARCHITECTURE.md; needs a decision, then testing on a Mac |

## Things a newcomer would trip over

- **Gopher URLs lose their port if the scheme is registered as standard.** Do not "fix" the missing registration.
- **Keys sent through the DevTools protocol skip the key dispatcher.** The smoke test uses `webContents.sendInputEvent` for that reason. Playwright's `keyboard.press` will appear to do nothing.
- **Code evaluated through the DevTools protocol is exempt from the page's `eval` ban.** Tests of the content policy must run from a timer or event inside the page.
- **`app.enableSandbox()` is skipped when a development build is started with `--no-sandbox`**, because Chromium child processes otherwise refuse to start as root. Packaged builds reject that flag.
- **The address field tracks the page unless the user has typed.** It does not rely on focus events, which are unreliable across views.
- Development-only environment variables, all ignored by packaged builds: `ANNE_DEV_GOPHER_PRIVATE=1` lets the build reach a Gopher server on this machine; `ANNE_DEV_USER_DATA=<dir>` puts the profile somewhere else; `ANNE_DEV_DOWNLOAD_DIR=<dir>` saves downloads there without a dialog. The smoke test uses all three.
- **Electron's `findInPage` option `findNext: true` starts a new search**, the opposite of what the name suggests. `BrowserWindow.find` handles this.
- **The download warning must be answered synchronously** inside `will-download`: Electron shows its save dialog as soon as the handler returns. That is why it uses `showMessageBoxSync`.
- **A tab that never loaded a page can make `savePage` wait forever.** Save Page As refuses anything that is not an http, https, file or gopher page.
- The smoke test replaces `dialog.showMessageBox`, `showMessageBoxSync`, `showSaveDialog` and `Menu.prototype.popup` in the main process to script native dialogs and capture context menus.

## Continuing the census

Suitable for Sonnet 5.5: it is bulk, rule-bound data entry, and the build rejects mistakes of structure. It still needs care about meaning; read each item's own description before linking.

Working loop:

1. `npm run census -- docs` prints the current state to `docs/CENSUS.md`; `docs/census-unlinked.tsv` is the queue (`git grep` or open it in a spreadsheet).
2. For a group of unlinked items, decide the canonical command (find it in `catalog/commands/`, or add a record to `catalog/commands/census.yaml`).
3. Add the items' normalized names to a file in `catalog/census/names/`. Print what a name looks like with `itemNames` in `tools/census/names.ts`, or just lower-case the key and delete punctuation.
4. If a word is ambiguous (the same name means different things in two browsers), add an entry to `overrides.yaml` instead, with a `why` for any `command: none`.
5. `npm run check`. A name used by two commands, an unknown command or a stale override fails the build.

Adding a browser version:

1. Add an entry to `catalog/census/sources.yaml` (repo, ref, extractor, files). If no extractor fits the format, write one in `tools/census/extractors.ts` and test it against a real sample.
2. `npm run census -- pin`, then `npm run census -- extract <id>`, then `npm run census:verify <id>`.
3. Link its items as above.

Things that need a decision, not just effort:

- **Closed-source browsers.** Internet Explorer, Opera, Safari, Netscape 4, Vivaldi cannot be read from here. Options: a person supplies menu dumps or screenshots (add a new source kind with a citation to the document), or leave them out. Do not enter them from memory: that is what `recalled` is for, and it is not evidence.
- **Release years** in `sources.yaml` are from memory. Check them against release notes.
- **Which unlinked items matter.** About half of Chromium's ids are internal. Decide whether to link the user-facing remainder or leave the tail.

Gotchas:

- GitHub's raw host rate-limits (HTTP 429). The fetcher spaces requests and retries; do not run several extractions in parallel.
- Only `raw.githubusercontent.com` and `git ls-remote` are reachable in the cloud environment. Documentation sites are blocked.
- ELinks has several keymaps (`main:`, `menu:`, `edit:`). Only `main:` is stripped to a bare name; `menu:home` and `edit:home` must not match "Home".
- Vimium's `scrollPageDown` is half a page; Lynx's `HOME` scrolls to the top of the document; w3m's `UNDO` undoes a cursor movement. The overrides file has the rest.
- A source file's text is decoded as UTF-8, falling back to Latin-1, so line numbers are stable for old files.
- **Scanned manuals** (`host: archive.org` in `sources.yaml`) are read from `https://archive.org/stream/<item>/<file>_djvu.txt`. Only that page is reachable; the archive's download servers (`ia*.us.archive.org`, `dn*.ca.archive.org`) and the Wayback Machine are not, so installers and page images cannot be fetched. Lending-library books return a page with no text block and are rejected.
- **Review every manual item in context.** Books describe helper programs too (Acrobat Reader's View > Full Screen appeared in a Netscape book), and OCR merges table columns into fake command names. Reject those in `overrides.yaml` with `command: none` and a reason.
- Other sites tried on 2026-11-26: Toastytech serves plain HTTP only, which the proxy does not carry; GUIdebook Gallery and the Wikimedia Commons API answered "too many requests" from this shared address even at one request every 12 seconds.
- `tools/census.ts` restarts itself with `NODE_USE_ENV_PROXY=1` when a proxy is configured, because Node's built-in fetch otherwise ignores it.
