# Architecture

Status: Phase 2 foundation and the first Phase 3 set (settings, find, bookmarks, history, downloads, private windows, permissions, context menus), built and tested. Desktop only (Electron 45, Chromium). This document describes what exists in the repository now.

## The one idea

Every user-visible action is a **command**: a data record in `catalog/`. Menus, the command palette, keyboard shortcuts, the lineage pages and (later) Android's command sheet are all generated from those records. Adding a command to the browser means adding a record and, if it does something, one handler function. Nothing else needs editing.

```
catalog/*.yaml ──build──▶ dist/catalog.json ──▶ CommandRegistry ──▶ handlers (app/main/commands.ts)
                                │                    ▲
                                ├──▶ menu builder ───┤  menu click
                                ├──▶ palette index ──┤  palette choice
                                └──▶ key dispatcher ─┘  key press
```

## Layout of the code

| Path | What it is | May import |
|---|---|---|
| `catalog/commands/*.yaml` | Command records | n/a |
| `catalog/layouts/*.yaml` | Menu layouts (one per era) | n/a |
| `catalog/keymaps/*.yaml` | Keyboard profiles | n/a |
| `schema/catalog.schema.json` | JSON Schema for the compiled catalog | n/a |
| `app/core/` | All logic. Plain TypeScript, no Electron | Node built-ins only |
| `app/main/` | Electron main process: windows, sessions, protocols | `app/core`, `electron` |
| `app/preload/` | The bridge exposed to the browser UI | `app/core` types, `electron` |
| `app/ui/` | The browser's own interface (tab strip, address bar, palette) | `app/core` types |
| `tools/` | Catalog compiler, bundler, end-to-end test | anything |
| `tests/` | Unit tests for `app/core` | `app/core` |

The rule that matters: **`app/core` never imports Electron.** That is what makes it unit-testable, and it is the part an Android port re-uses or re-implements against the same test vectors.

## Core modules

| Module | Responsibility |
|---|---|
| `catalog/types.ts`, `catalog/validate.ts` | Record types; cross-reference checks the schema cannot express |
| `when/when.ts` | Context expressions (`tab.canGoBack && !ui.paletteOpen`). Hand-written parser; no `eval` |
| `context.ts` | The closed list of context keys an expression may read |
| `registry.ts` | The single execution path for commands (see below) |
| `keys/chord.ts`, `keys/resolver.ts` | Chord parsing, keymap layering, multi-key sequences, conflict detection |
| `menu/build.ts` | Layout + registry + context → a plain menu tree; generates the "Everything" layout |
| `palette/search.ts` | Fuzzy search over labels, aliases, ids and lineage |
| `security/*.ts` | Navigation, network-destination, permission, download and startup policies |
| `gopher/*.ts` | Gopher URL parsing, menu parsing, HTML rendering, network client |
| `ipc.ts` | The UI ↔ main message contract and its validators |
| `data/storage.ts` | Atomic JSON file writes; corrupt files moved aside, never overwritten |
| `data/settings.ts` | Settings schema, defaults, validation and the settings store |
| `data/url-store.ts` | Capped, searchable page list: the model for both bookmarks and history |
| `menu/context.ts` | Which commands a right-click offers, given what was clicked |
| `pages.ts` | Script-free internal pages (home, about, stub explanations, archaeology) |

## How a command runs

`CommandRegistry.execute(id, { source, host, args })` is the only way a command runs. In order, it checks:

1. The command exists and is not `omit`.
2. It is available on this platform.
3. The **source** is allowed every capability the command `requires`. Menu, key, palette and toolbar are direct user actions and may use everything. A `macro` may not use `credentials` or `external-app`. An `extension` may use nothing yet.
4. The arguments match the record's `args` specification exactly: no unknown names, correct types, bounded length.
5. `stub` commands stop here and show their explanation page.
6. The `when` expression is true in the window's current context.
7. A handler is registered; otherwise the user is told the command is not built yet.

Handlers therefore never validate "may this run?" themselves. They do validate anything that reaches the outside world, for example a URL argument goes through the navigation policy.

`onDidExecute` fires after every successful run. The macro recorder (Phase 7) and any local activity log attach there.

## Catalog rules enforced at build time

`npm run catalog` fails if any of these is violated, so the runtime may assume them:

- Ids are unique and start with their category (`tab.reopen-closed` is in `tab`).
- `emulate`, `stub` and `omit` records carry a `status_reason`.
- Every `when` and `checked` expression parses and reads only known context keys.
- Layouts and keymaps reference existing, non-omitted commands.
- A binding supplies every required argument of its command, with the right types.
- **A binding that starts with an ordinary typing key must be scoped with `input.modal`.** Typing in a page can never trigger a command unless the user has switched modal mode on.
- No duplicate bindings inside one keymap.

## Process model

```
┌────────────────────────── main process (trusted) ──────────────────────────┐
│ registry · policies · window/tab controller · protocol handlers · Gopher   │
└───────▲──────────────────────────────────────────────▲─────────────────────┘
        │ 5-function bridge, validated                 │ no bridge at all
┌───────┴─────────────┐                      ┌─────────┴──────────────────────┐
│ UI renderer          │                      │ tab renderers (one per site)   │
│ session "anne-ui"    │                      │ normal windows: "persist:web"  │
│ anne://chrome/…      │                      │ each private window: its own   │
│ sandboxed, no network│                      │   in-memory "anne-private-N"   │
└──────────────────────┘                      └────────────────────────────────┘
```

- A window is a `BaseWindow` holding one `WebContentsView` for the UI and one per tab. Only the active tab's view is attached.
- The UI view is the toolbar strip, plus the find bar and a notice line when they are showing. When an **overlay** opens (the command palette, or the bookmarks, history or downloads panel), the UI view grows to cover the window and is raised above the page; when it closes, it shrinks back. Panels are drawn in the UI view, not as internal pages, because they need interaction (decision A8).
- **Private windows** each get a fresh in-memory partition. Each web session (the persistent one and every private one) is prepared once with the same hardening, protocol handlers, Ruffle server, download handling and its own permission policy. When a private window closes, its storage, cache, permission answers and download entries are erased.
- **Keys are handled in the main process** (`before-input-event`), before the page sees them. A page cannot block or observe browser shortcuts. Menu accelerators are display-only on Windows and Linux so a key is never acted on twice.
- Window state flows one way: main → UI (`anne:state`). The UI holds no authority; it renders state and sends requests.

## Profile data

| File (under `userData/profile/`) | Holds | Written |
|---|---|---|
| `settings.json` | Layout, keymap, home page, search template | Immediately on change |
| `bookmarks.json` | Bookmarks (flat list, up to 10,000) | 200 ms after a change |
| `history.json` | Visited pages (up to 5,000, oldest dropped) | 1 s after a change, and on quit |

All writes are atomic. On load, unknown keys are dropped, invalid values fall back to defaults, and a file that cannot be parsed is renamed to `<name>.corrupt-<time>` rather than overwritten. Problems are printed at startup.

- Layout and keymap chosen in a window apply to that window and become the default for new windows. Private windows never write settings.
- History records main-frame loads with a status below 400, for `http`, `https`, `gopher` and `file` pages only, never in private windows. Embedded credentials are never stored.
- The download list is kept in memory for the session only. The files themselves stay where they were saved.
- Permission answers last until the browser quits (or the private window closes). Remembering them across restarts is not built.

## Custom URL schemes

| Scheme | Where it exists | Registered as | Serves |
|---|---|---|---|
| `anne://chrome/` | UI session only | standard, secure | The browser's interface files |
| `anne://pages/` | Web session only | standard, secure | Script-free internal pages |
| `anne-ruffle://app/` | Web session only | standard, secure, fetch, CORS, CSP-exempt | Ruffle's script and WebAssembly, to tabs with Flash turned on |
| `gopher://` | Web session only | **not registered** | Pages generated by the Gopher client |

Gopher is deliberately left unregistered. Chromium gives custom "standard" schemes no port, and silently rewrote `gopher://host:7070/` to `gopher://host/` when it was registered. Unregistered, the URL is kept as written and each page has an opaque origin. Any future scheme that needs ports (FTP, NNTP, Finger) must follow the same rule.

## Decisions still open in the architecture

These are designed but not built. Each is small enough to specify here and hand off.

**Several profiles.** There is one profile today, at `userData/profile/`. Adding more means a profile picker and passing the profile directory to the three stores; nothing inside them changes.

**User keybindings.** Planned as an ordinary keymap file in the profile with `extends` pointing at the chosen keymap, so the existing resolver needs no change. Imported keymaps must be validated with `validateCatalog` before use.

**Bookmark folders and import.** Bookmarks are a flat list. Folders need a parent field and a tree view in the panel; import from other browsers (HTML bookmark files) is Phase 3 follow-up work and must treat the file as untrusted data.

**Extensions.** Electron loads unpacked Chrome extensions with a partial API (no `chrome.tabs` beyond basics, no Web Store install flow, incomplete Manifest V3 service-worker support). Full extension support is therefore not a Phase 3 item. Plan: support a vetted list first (content blockers), each requested capability mapped to a registry `extension` grant, and revisit after Phase 5.

**Android.** `dist/catalog.json` is the shared artifact. The Kotlin app re-implements three small pieces (context expressions, registry checks, key resolution) and must pass the same test vectors as `tests/when.test.ts`, `tests/keys.test.ts` and `tests/registry.test.ts`, exported as JSON. The policies in `app/core/security` port the same way. Everything in `app/main` is desktop-only and is rewritten on GeckoView.

**macOS.** Menu accelerators cannot be made display-only on macOS, so a shortcut shown in the menu would fire both from the menu and from the key dispatcher. Before a macOS release, the menu adapter must omit accelerators there and show shortcuts another way, or the dispatcher must skip chords the application menu owns. Untested: no macOS machine was available.

## Build and test

| Command | Does |
|---|---|
| `npm run catalog` | Validate and compile the catalog to `dist/catalog.json` |
| `npm run typecheck` | Strict TypeScript check of everything |
| `npm test` | Unit tests for `app/core` |
| `npm run build` | Catalog + bundle main, preload, UI; copy Ruffle |
| `npm start` | Build and run |
| `npm run smoke` | Build, launch the real app, and assert the security boundaries end to end |
| `npm run check` | typecheck + catalog + unit tests |

Tools and tests run TypeScript directly on Node 22 (type stripping), so the code avoids syntax that needs transformation (`enum`, constructor parameter properties). `tsconfig.json` enforces this with `erasableSyntaxOnly`.
