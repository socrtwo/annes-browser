# Handoff: what to do next, and with which model

Written at the end of the Phase 2 foundation session (2026-11-25); updated after the first Phase 3 session (2026-11-26).

## Where things stand

Built and tested: the command registry, context expressions, keymaps and key dispatch, menu building, palette search, the navigation / network / permission / download policies, a hardened Electron shell with tabs, a Gopher client, and Flash emulation through Ruffle. 45 seed commands, 3 hand-made layouts plus the generated "Everything" layout, 2 keymaps.

Verification: `npm run check` (typecheck, catalog build, 91 unit tests) and `npm run smoke` (105 end-to-end checks) pass on Linux. Not run on Windows or macOS. See the limitations in `SECURITY-MODEL.md`.

## Why the work switches model here

The decisions that are expensive to get wrong are made and enforced by code: one execution path, the session split, the navigation policy, the network policy for protocol clients, and the rule that tabs get no bridge. What remains is mostly **wide** work that follows these patterns: many command handlers, the census data, UI for existing policies. That is cheaper on Opus 5.5 at medium effort (or Sonnet 5.5 for the census), and a mistake in one handler does not spread.

## Work for Opus 5.5 (medium)

In suggested order. Each item names the pattern to copy.

1. ~~Settings store~~ **Done** (2026-11-26).
2. ~~Phase 3 commands: find, save page, bookmarks, history, downloads list, page info, private window, clear data, context menus~~ **Done** (2026-11-26). Remaining Phase 3: HTTP authentication dialog, bookmark folders and import, history grouped by day, per-site zoom memory, print preview, spell-check language choice, "remember" for permission answers across restarts.
3. ~~Permission prompt UI and download warnings~~ **Done** (2026-11-26).
4. **Phase 1 census.** Fill `catalog/commands/` from sources, replacing the provisional lineage. Split into one file per category. `npm run catalog` validates everything.
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
