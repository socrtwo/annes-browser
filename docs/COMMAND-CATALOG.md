# Command Catalog: Schema and Taxonomy

The catalog (`catalog/commands.yaml`, built in Phase 1) is the single source of truth. Menus, the command palette, keybindings, help pages and tests are all generated from it.

## Record schema

```yaml
- id: page.edit-in-composer          # stable, dotted, lowercase
  label: "Edit Page"                  # default UI label
  aliases: ["Edit Page", "Compose", "Edit with Composer", "Edit in FrontPage"]
  category: page                      # see taxonomy below
  description: "Open the current page in the built-in WYSIWYG HTML editor."
  lineage:
    - { browser: "Netscape Communicator", versions: "4.0-4.8", menu: "File > Edit Page", year: 1997 }
    - { browser: "Internet Explorer", versions: "5-6", menu: "File > Edit with Microsoft FrontPage", year: 1999 }
    - { browser: "SeaMonkey", versions: "1.0+", menu: "File > Edit Page", year: 2006 }
  status: emulate                     # implement | emulate | stub | omit
  status_reason: "Composer retired; re-implemented as built-in editor."
  phase: 6
  platforms: [desktop]                # desktop | android
  shortcuts:
    default: null
    classic-netscape: "Ctrl+E"
  args: []                            # optional typed arguments for palette/macros
  checked_state: false                # true if it is a toggle
  requires: []                        # permissions/capabilities, e.g. [network, filesystem]
  layouts: [1999-suite, everything]   # era layouts that place it in a menu
  menu_path:
    1999-suite: "File/Edit Page"
    everything: "Page/Edit/Edit Page"
```

## Category taxonomy

| Category | Examples |
|---|---|
| `app` | New window, private window, quit, profiles, task manager |
| `file` | Open file/location, save as (all formats), print, page setup, send link, import/export |
| `edit` | Undo/redo, cut/copy/paste variants, select all, find, find again, preferences |
| `view` | Toolbars, sidebar, status bar, zoom, text size, full screen, encoding, page style, text-only, images on/off |
| `nav` | Back/forward/home/reload/stop, history menu, fast-forward, up one level, go to address |
| `tab` | New, close, duplicate, pin, mute, move, group, stack, tile, hibernate, reopen closed |
| `bookmark` | Add, manage, keywords, quickmarks, speed dial, reading list, feeds |
| `history` | Show, search, clear, sessions save/restore |
| `page` | Page info, view source, edit page, translate, reader, compare, diff since last visit, view as of… |
| `tools` | Downloads, extensions, DevTools, cookies/cache viewers, user agent, network report, macros |
| `privacy` | Shields/blockers, permissions, containers, clear data, Tor window |
| `input` | Gestures, rocker gestures, modal keys, hints, command line |
| `extract` | OCR, table to CSV, links/images list, bulk download, copy as citation/Markdown |
| `legacy` | Gopher, FTP, Flash (Ruffle), plugin stubs, channels |
| `module` | Notes, HTML editor, NNTP reader, IRC, feed reader |
| `help` | Help contents, keyboard reference, menu archaeology, about |

## Status definitions

- **implement**: native behavior on the current engine.
- **emulate**: original technology gone; equivalent behavior provided another way.
- **stub**: appears in the menu (in historic layouts and the palette) and opens an explanation of why it is unavailable (usually security).
- **omit**: catalogued for completeness, never shown (for example vendor-service links to defunct sites).
