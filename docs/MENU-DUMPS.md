# Reading a browser's menus on your own computer

Some menus cannot be read from files: Safari's menu bar, and the current Chromium-based Opera and Edge. Two scripts read them from the running program instead. They click nothing and send nothing anywhere; the output goes to the terminal.

Neither script has been run by the project yet: they were written in a Linux container with no macOS or Windows to test on. Report anything that goes wrong.

## macOS (Safari, Opera, Edge, Chrome, Vivaldi, any app)

macOS menus are native for every browser, so this works for all of them.

1. Start the browser. **Use a new, empty profile** (or Safari with history and bookmarks cleared), so no personal page titles appear in its menus.
2. Allow the terminal to read other apps' menus: **System Settings > Privacy & Security > Accessibility**, add Terminal (or iTerm) and switch it on.
3. From the repository folder run, with the app's name exactly as it appears in the menu bar:

   ```sh
   osascript -l JavaScript tools/menu-dump/macos-menus.js Safari > safari-18.1-macos-menus.txt
   ```

   About a minute for a large menu bar. macOS may ask once whether Terminal may control System Events: allow it.
4. Open the file and read it through. Lines starting `#? ` came from History, Bookmarks, Window and similar menus, which list your own pages. Delete those lines, or remove the `#? ` from the few that are real commands (for example *Clear History*).

## Windows (classic programs only)

`windows-menus.ps1` reads real Windows menus. Internet Explorer 3–6, Netscape 2–4, Opera 3–6 and K-Meleon have them. Chrome, Edge, Firefox, Opera 15+ and Vivaldi draw their own menus, so the script finds nothing in them. On Windows, read those on a Mac instead, or not at all.

```powershell
powershell -ExecutionPolicy Bypass -File tools\menu-dump\windows-menus.ps1 -Process iexplore > ie-6-windows-menus.txt
```

Open each menu once before running: some programs fill a submenu only when it first opens. Review the `#? ` lines in the same way as on macOS.

## Adding the result to the census

1. Rename the file to lower case with no spaces (for example `safari-18.1-macos-menus.txt`) and put it in `catalog/census/transcriptions/`.
2. Add a source to `catalog/census/sources.yaml`:

   ```yaml
   - id: safari-18.1-macos
     browser: Safari
     version: "18.1"
     released: 2024
     platform: macOS
     host: machine
     repo: "Safari 18.1 (20619.2.8), macOS 15.1"
     ref: "menus read with tools/menu-dump/macos-menus.js"
     extractor: transcription
     files:
       - path: safari-18.1-macos-menus.txt
         role: primary
   ```

3. Run `npm run census -- extract safari-18.1-macos`, then `npm run census:verify safari-18.1-macos`, then `npm run check`.
4. Link the new items as described in [HANDOFF.md](HANDOFF.md#continuing-the-census).

The lineage records these items as the browser's own menus (`census`), but only the person who ran the script can read them again. The version and date in the file's header are the citation.
