# Anne's Browser

**Every menu command from 35 years of web browsers, plus new ones, in one searchable, customizable browser.**

> Status: **Pre-development / planning.** This repository holds only metadata, the roadmap and the cost estimate. No application code exists yet.

## Concept

Browsers have gained and dropped hundreds of commands since WorldWideWeb (1990). Some were superseded and some were simply forgotten. Many were good ideas that disappeared when a product died: Opera's notes, panels and fit-to-width, Netscape Composer, Konqueror's split views, Vivaldi's tab tiling, Arc's spaces, and Lynx's text-only rendering.

Anne's Browser catalogs those commands, de-duplicates them into one canonical set and makes each one reachable in three ways:

1. **Menus**: classic menu bars, with switchable "era layouts" (1994 minimal, 1999 suite, 2008 tabbed, modern hamburger).
2. **Command palette**: fuzzy search over every command by name, alias or the historic browser it came from.
3. **Keyboard and gestures**: remappable shortcuts, mouse gestures and an optional modal (vi-style) mode.

On top of the historic set, it adds new commands aimed at research, publishing, OCR, genealogy and archiving (see [ROADMAP.md](ROADMAP.md), Phase 7).

## Design principles

- **Don't write a rendering engine.** Build a shell on an existing, maintained engine (Chromium via Electron or CEF, or Gecko via GeckoView on Android). The value is in the command layer, not in layout code.
- **One command registry drives everything.** Each command is a data record (id, label, category, lineage, default shortcuts, platform availability, implementation status). Menus, the palette, help text, keybindings and documentation are all generated from it.
- **Lineage is a feature.** Every command records which browsers and versions introduced or carried it, and "Menu archaeology" mode shows that history to the user.
- **Obsolete is not the same as unsafe.** Retired features are classified as *implement*, *emulate* (for example Flash through Ruffle, or Gopher through a built-in client), *stub with explanation* (ActiveX, NPAPI, Java applets) or *omit*.
- **No trade dress.** Era layouts recreate how menus were *organized*, not anyone's logos, artwork or branding.
- **Privacy by default.** No telemetry. Any AI or cloud-backed commands are opt-in and bring-your-own-key.

## Browsers surveyed (command census sources)

| Era | Browsers |
|---|---|
| 1990–1995 | WorldWideWeb/Nexus, Line Mode Browser, ViolaWWW, Erwise, Cello, Lynx, NCSA Mosaic, Netscape Navigator 1–2, Internet Explorer 1–2 |
| 1996–2003 | Netscape Navigator/Communicator 3–4.x, Netscape 6–7, Internet Explorer 3–6, Opera 3–7, Mozilla Application Suite, iCab, OmniWeb, Konqueror, Galeon, K-Meleon, Links/ELinks, w3m, Dillo |
| 2003–2010 | Firefox 1–3.6, Safari 1–5, Camino, Epiphany, SeaMonkey, Flock, Opera 8–10 (Presto), Internet Explorer 7–8, Google Chrome 1–8 |
| 2010–2020 | Firefox 4–Quantum, Opera 11–12 (Presto) and 15+ (Blink), Chrome, Internet Explorer 9–11, Edge Legacy, Vivaldi, Brave, Pale Moon, Waterfox, qutebrowser, Min, NetSurf |
| 2020–present | Edge (Chromium), Firefox, Chrome, Safari, Vivaldi, Brave, Opera/Opera GX, Arc, Zen, Floorp, Orion, Ladybird, Sidekick, SigmaOS |
| Mobile | Opera Mini/Mobile, Safari iOS, Chrome Android, Firefox Android/Focus, Samsung Internet, UC Browser, DuckDuckGo, Kiwi, Dolphin |

## Planned platforms

To be decided in Phase 0. The recommendation is in [ROADMAP.md](ROADMAP.md): desktop (Windows, macOS, Linux) first on Electron, then Android on GeckoView.

## Repository layout (planned)

```
annes-browser/
├── README.md              This file
├── ROADMAP.md             Phased plan, exit criteria, open decisions
├── COST-ESTIMATE.md       Token and cost estimates (Claude and alternatives)
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
├── docs/
│   └── COMMAND-CATALOG.md Command record schema and category taxonomy
├── catalog/               (Phase 1) commands.yaml and per-browser source lists
├── app/                   (Phase 2+) application code
└── .github/ISSUE_TEMPLATE Command-request template
```

## License

MIT (placeholder, to be confirmed in Phase 0). See [LICENSE](LICENSE).
