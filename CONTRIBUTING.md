# Contributing to Anne's Browser

The foundation is built (see `docs/ARCHITECTURE.md`). The most useful contribution right now is **command census data**.

## Submitting a historic or current browser command

Open an issue with the **Command request** template, or a PR adding a record under `catalog/commands/` (format in `docs/COMMAND-CATALOG.md`). Include:

- Browser, version and platform
- Exact menu path or shortcut (for example `File > Edit Page`, `Ctrl+E`)
- What it did
- A source: manual page, archived screenshot URL or source-code link

## Ground rules

- No vendor logos, icons or artwork in the repository.
- Do not paste copyrighted manual text. Paraphrase and cite instead.
- Every new command must have a catalog record before any code is written for it.

## Code rules

- `app/core` never imports Electron.
- Tabs get no preload script, and `anne://pages` pages carry no script.
- A new URL scheme, IPC channel, `executeJavaScript` call or network client is a security change: add checks for it to `tools/smoke.ts` and read `docs/SECURITY-MODEL.md` first.
- `npm run check` and `npm run smoke` must pass before a commit.
