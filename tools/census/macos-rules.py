#!/usr/bin/env python3
"""Rule table for menus read on macOS (host: machine, ids ending in -macos). Optional helper; needs PyYAML.

Run from the repository root after `npm run census -- docs`. Prints override lines for items still
unlinked; review them and append to catalog/census/overrides.yaml. Existing overrides are never replaced.
A rule: (label regex, menu regex or None, command or ('none', why)). Labels are compared lower-case,
without a trailing ellipsis. First match wins.
"""
import csv, re, sys, yaml

SYSTEM = ('none', 'a macOS system entry that every application menu or Edit menu shows')
R = [
    # application menu
    (r'^about ', r'^(Safari|Edge|Opera)$', 'help.about'),
    (r'extensions$', r'^(Safari|Edge|Opera)$', 'tools.manage-extensions'),
    (r'^(settings|preferences)$', r'^(Safari|Edge|Opera)$', 'tools.preferences'),
    (r'default browser', None, 'tools.set-default-browser'),
    (r'^(delete|clear) browsing data$', None, 'privacy.clear-data'),
    (r'^import (browser|browsing) data', None, 'tools.import-settings'),
    (r'^hide (safari|microsoft edge|opera)$', None, 'app.hide'),
    (r'^(hide others|show all|services settings)$', None, SYSTEM),
    (r'^warn before quitting$', None, ('none', 'a setting for the quit confirmation, not a command')),
    (r'^quit ', None, 'app.quit'),
    (r'^privacy report$', None, 'privacy.report'),
    # File
    (r'^new (inprivate|private) window$', None, 'app.new-private-window'),
    (r'^new isolated window$', None, ('none', "opens a window kept apart from Edge's other windows; no matching command yet")),
    (r'^close all$', r'^File$', 'app.close-window'),
    (r'^email link$', None, 'file.send-link'),
    (r'^print using system dialog$', None, 'file.print-system'),
    (r'^share$', r'^File$', 'file.share'),
    (r'^export as pdf$', None, 'file.export-pdf'),
    # Edit
    (r'^search the web$|^google search$', r'Find', 'input.focus-search'),
    (r'^use selection (to|for) find$', None, 'edit.find-selection'),
    (r'^jump to selection$', None, ('none', 'scrolls the selected text into view; a macOS text-system command')),
    (r'^show spelling and grammar$', None, 'edit.spell-check'),
    (r'^check document now$', None, 'edit.check-spelling-now'),
    (r'^check grammar (and|with) spelling$', None, 'edit.spell-check'),
    (r'^make (upper|lower) ?case$|^capitalize$', None, 'edit.transform-case'),
    (r'^(contact|credit card)$', r'AutoFill$', 'edit.autofill'),
    (r'^(start dictation|emoji & symbols)$', None, SYSTEM),
    # View
    (r'^(always|never|only on new tabs)$', r'Show Favorites Bar$', 'view.toggle-bookmarks-bar'),
    (r'^always show full urls$', None, 'view.show-full-urls'),
    (r'^refresh this page$', None, 'nav.reload'),
    (r'^fit to page$', None, ('none', "Edge's PDF viewer: fits the document to the window")),
    (r'^rotate$', None, ('none', "Edge's PDF viewer: rotates the document")),
    (r'^cast media to device$|^cast$', None, 'tab.send-to-device'),
    (r'^developer tools$', None, 'tools.dev-tools'),
    (r'^inspect elements?$', None, 'tools.inspect-element'),
    (r'^javascript console$', None, 'tools.dev-tools-console'),
    (r'^allow javascript from apple events$', None, ('none', 'a macOS automation permission for scripts, not a page command')),
    (r'^always show toolbar in full screen$', None, ('none', 'a full-screen display setting')),
    # History, Favorites
    (r'^show (full|all) history$', None, 'history.show'),
    (r'^manage (favorites|bookmarks)$', None, 'bookmark.show'),
    (r'^add this page to favorites$', None, 'bookmark.toggle'),
    (r'^add open pages to favorites$', None, 'bookmark.add-all-tabs'),
    (r'^manage profile settings$', None, 'app.new-profile'),
    # Tab
    (r'^new tab to the right$', None, 'tab.new-right'),
    (r'^duplicate$', r'^Tab$', 'tab.duplicate'),
    (r'^switch to last active tab$', None, 'tab.visit-previous'),
    (r'^mute (tab|selected site)$', None, 'tab.mute'),
    (r'^pin tab$', None, 'tab.pin'),
    (r'^group tab$', None, 'tab.new-group'),
    (r'^close tabs to the right$', None, 'tab.close-to-end'),
    (r'^add tab to new split view$', None, 'tab.split-vertical'),
    # Window
    (r'^zoom$', r'^Window$', 'app.maximize-window'),
    (r'^minimize$', r'^Window$', 'app.minimize-window'),
    (r'^name window$', None, ('none', 'gives the window a title of its own; no matching command yet')),
    (r'^downloads$', r'^Window$', 'tools.downloads'),
    # Help
    (r'help$', r'^Help$', 'help.contents'),
    (r'^update ', r'^Help$', 'help.check-for-updates'),
    (r'^send feedback$', r'^Help$', 'help.feedback'),
]

clean = lambda s: re.sub(r'(…|\.\.\.)$', '', s).strip().lower()
rows = [r for r in csv.DictReader(open('docs/census-unlinked.tsv'), delimiter='\t') if r['source'].endswith('-macos')]
existing = {(o['source'], str(o['key'])) for o in yaml.safe_load(open('catalog/census/overrides.yaml'))}
# Wrong automatic links found in review are replaced too: Window > Zoom resizes the window on macOS.
fixes = [('Window/Zoom', 'app.maximize-window')]
out = []
for r in rows:
    if (r['source'], r['key']) in existing:
        continue
    where, label = r['key'].split('/', 1) if '/' in r['key'] else ('', r['key'])
    for lp, mp, cmd in R:
        if re.search(lp, clean(label)) and (mp is None or re.search(mp, where)):
            if isinstance(cmd, tuple):
                out.append(f'- {{ source: {r["source"]}, key: "{r["key"]}", command: none, why: "{cmd[1]}" }}')
            else:
                out.append(f'- {{ source: {r["source"]}, key: "{r["key"]}", command: {cmd} }}')
            break
for src in sorted({r['source'] for r in rows}):
    for key, cmd in fixes:
        if (src, key) not in existing:
            out.append(f'- {{ source: {src}, key: "{key}", command: {cmd} }}')
print('\n'.join(out))
print(f'{len(out)} overrides', file=sys.stderr)
