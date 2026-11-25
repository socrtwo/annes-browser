# Command Catalog: Schema and Taxonomy

The catalog is the single source of truth. It has three parts, all under `catalog/`, compiled by `npm run catalog` into `dist/catalog.json`:

| Directory | Contents |
|---|---|
| `catalog/commands/*.yaml` | Command records (each file is a list) |
| `catalog/layouts/*.yaml` | Menu layouts, one file per era |
| `catalog/keymaps/*.yaml` | Keyboard profiles |

The compiled form is described by `schema/catalog.schema.json`. Rules the schema cannot express are in `app/core/catalog/validate.ts`.

## Command record

```yaml
- id: page.edit-in-composer          # stable, dotted, lowercase; must start with its category
  label: Edit Page                   # default UI label
  aliases: [Composer, Edit with FrontPage]   # extra names the palette matches
  category: page                     # see taxonomy below
  description: Open the current page in the built-in HTML editor.
  lineage:                           # where the command came from
    - { browser: Netscape Communicator, versions: "4.0-4.8", menu: "File > Edit Page", year: 1997 }
  status: emulate                    # implement | emulate | stub | omit
  status_reason: Composer was retired with the Netscape suite; a built-in editor replaces it.
  phase: 6                           # roadmap phase that builds it
  platforms: [desktop]               # desktop | android
  when: "page.scheme == 'http' || page.scheme == 'https'"   # enabled only while true
  checked: window.isFullScreen       # present only for toggles: their checked state
  requires: [network]                # capabilities; see below
  args:                              # typed arguments, for the palette, keymaps and macros
    - { name: url, type: url, optional: true, description: Page to edit }
```

`status_reason` is required unless the status is `implement`. For a `stub` it is the text shown to the user.

### Context expressions (`when`, `checked`)

Operators: `!`, `&&`, `||`, `==`, `!=`, `<`, `<=`, `>`, `>=`, parentheses. Operands: context keys, numbers, quoted strings, `true`, `false`. The allowed keys are listed in `app/core/context.ts`; using any other key is a build error.

### Capabilities (`requires`)

`network`, `filesystem`, `clipboard`, `external-app`, `page-script`, `history`, `credentials`. Direct user actions may use all of them. Macros may not use `credentials` or `external-app`. Extensions may use none yet.

### Argument types

`string`, `number`, `boolean`, `url`. A `url` argument is a string that the handler must pass through the navigation policy.

## Layout file

```yaml
id: suite-1999
label: 1999 Suite
description: The communicator-suite arrangement.
menus:
  - label: File
    items:
      - label: New                    # a submenu
        items: [app.new-window, tab.new]
      - file.open-location            # a command id
      - { separator: true }
      - app.quit
```

A layout only arranges commands; it never changes what is available. Commands that are omitted or not on the current platform are dropped, and empty submenus and doubled separators are cleaned up. The layout id `everything` is reserved: it is generated from the categories.

## Keymap file

```yaml
id: vi
label: Vi (modal)
extends: default                      # layer on top of another keymap
bindings:
  - { keys: Mod+T, command: tab.new }
  - { keys: G T, command: tab.next, when: input.modal }       # two-key sequence
  - { keys: Mod+1, command: tab.select, args: { index: 1 } }
  - { keys: Ctrl+W, command: "-" }                            # remove an inherited binding
```

- Chords: modifiers `Ctrl`, `Alt`, `Shift`, `Meta`, and `Mod` (Cmd on macOS, Ctrl elsewhere), then a key. Sequences are chords separated by spaces, up to four.
- Punctuation stands for the character produced, so write `?`, not `Shift+/`.
- A binding that starts with a plain typing key must have a `when` that includes `input.modal`.

## Category taxonomy

| Category | Examples |
|---|---|
| `app` | New window, private window, quit, profiles, command palette |
| `file` | Open file/location, save as (all formats), print, page setup, send link, import/export |
| `edit` | Undo/redo, cut/copy/paste variants, select all, find, preferences |
| `view` | Toolbars, sidebar, status bar, zoom, full screen, encoding, page style, text-only, images on/off, menu layout |
| `nav` | Back/forward/home/reload/stop, history menu, fast-forward, up one level, go to address |
| `tab` | New, close, duplicate, pin, mute, move, group, stack, tile, hibernate, reopen closed |
| `bookmark` | Add, manage, keywords, quickmarks, speed dial, reading list, feeds |
| `history` | Show, search, clear, sessions save/restore |
| `page` | Page info, edit page, translate, reader, compare, diff since last visit, view as of… |
| `tools` | Downloads, extensions, developer tools, cookie/cache viewers, user agent, network report, macros |
| `privacy` | Blockers, permissions, containers, clear data, Tor window |
| `input` | Gestures, rocker gestures, modal keys, hints, command line |
| `extract` | OCR, table to CSV, links/images list, bulk download, copy as citation/Markdown |
| `legacy` | Gopher, FTP, Flash (Ruffle), plugin stubs, channels |
| `module` | Notes, HTML editor, NNTP reader, IRC, feed reader |
| `help` | Help contents, keyboard reference, menu archaeology, about |

## Status definitions

- **implement**: native behavior on the current engine.
- **emulate**: original technology gone; equivalent behavior provided another way.
- **stub**: appears in menus and the palette, and opens a page explaining why it is unavailable (usually security).
- **omit**: catalogued for completeness, never shown (for example vendor-service links to defunct sites).
