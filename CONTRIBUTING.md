# Contributing to Anne's Browser

The foundation is built (see `docs/ARCHITECTURE.md`). The most useful contribution right now is **command census data**.

## Adding to the command census

A command's history is generated from `catalog/census/`, which is read from open-source browsers' own code (see `docs/CENSUS.md`). To contribute:

- **A browser version we can read:** add it to `catalog/census/sources.yaml` and follow "Adding a browser version" in `docs/HANDOFF.md`.
- **Linking unlinked items:** see "Continuing the census" in `docs/HANDOFF.md`. Read an item's own description before deciding two browsers' commands are the same.
- **A closed-source browser** (Internet Explorer, Opera, Safari and others): we cannot read these. If you can supply a menu dump or a screenshot, open an issue with the **Command request** template and say where it came from. Memory alone is recorded as "unverified".

Census files store identifiers, labels and short descriptions (100 characters at most), never source code. Do not paste copyrighted manual text.

## Ground rules

- No vendor logos, icons or artwork in the repository.
- Every new command must have a catalog record before any code is written for it.
- `npm run check` also validates the census: a name that belongs to two commands, or an override for an item that is not there, fails the build.

## Code rules

- `app/core` never imports Electron.
- Tabs get no preload script, and `anne://pages` pages carry no script.
- A new URL scheme, IPC channel, `executeJavaScript` call or network client is a security change: add checks for it to `tools/smoke.ts` and read `docs/SECURITY-MODEL.md` first.
- `npm run check` and `npm run smoke` must pass before a commit.
