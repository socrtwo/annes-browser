# Integrations

How external technology is, or will be, connected. "Built" means in the repository and tested.

## Pattern for a legacy protocol client

Gopher is the reference implementation. A new client (FTP, NNTP, Finger) follows the same shape:

1. `app/core/<proto>/parse.ts`: pure parsing of URLs and server responses. Reject control characters in anything that becomes part of a command line.
2. `app/core/<proto>/client.ts`: the network client, with injectable `resolve` and `connect` for tests, and a `handle<Proto>Url(url, opts)` function that **never throws** and returns `{ status, headers, body }`.
3. `app/core/<proto>/render.ts`: HTML generated with `escapeHtml`, served with a `default-src 'none'; … sandbox` policy.
4. `app/main/protocols.ts`: one `ses.protocol.handle` call in the web session. Do **not** register the scheme as standard (ports are dropped).
5. `app/main/security.ts`: allow the scheme as a top-level page only.
6. `app/core/security/url-policy.ts`: add the scheme to the allowed list (and remove it from `COMMAND_SCHEMES` if it was routed to a stub).
7. Tests: unit tests against a local in-process server, a random-input test for the parser and renderer, and smoke checks that a web page cannot trigger a connection.

Mandatory network rules, from `SECURITY-MODEL.md`: top-level only; no line smuggling; restricted ports; public addresses only with the connection pinned to the checked address; size and time limits.

## Built

### Gopher

`app/core/gopher/`. Menus, text, search (type 7), images (by content sniffing), HTML (inert), binary downloads. Selectors are handled as bytes, so Latin-1 servers work. Not built: Gopher+ attributes, CSO phone books, telnet items (shown as text). Responses are buffered, not streamed, with a 64 MB cap.

Not tested against a public Gopher server: this build machine has no outbound access on port 70. Tested against a local server only.

### Flash through Ruffle

`@ruffle-rs/ruffle` 0.8.0, copied unmodified to `dist/ruffle/` and served at `anne-ruffle://app/`. The **Run Flash Content** command (`legacy.flash`) turns it on for the active tab. See `SECURITY-MODEL.md` for the constraints.

Tested with a minimal hand-built SWF (version 6, one frame). Not tested with real-world movies, ActionScript 3 content, or pages that set a strict content policy (which will block the emulator's WebAssembly; the user is told the page does not allow it only if injection itself fails).

Ruffle adds about 30 MB to the build (two WebAssembly variants). Shockwave Director content is not Flash and is not supported.

## Specified, not built

### FTP (read-only) — `legacy.ftp-open`

Scope: anonymous login; directory listings; file download. No upload, no rename, no delete.

Additional rules beyond the common five:

- **Ignore the address in the PASV reply.** Connect the data channel to the same address as the control channel, using only the port from the reply. (Otherwise a server can direct the browser to connect anywhere: the classic FTP bounce.) Prefer `EPSV`, which carries no address.
- Never use active mode (`PORT`/`EPRT`).
- The decoded path must not contain CR, LF or NUL: it is sent on the control channel.
- Control-channel reader: cap line length (4 KB) and reply size; handle multi-line replies; time out.
- Port 21 is on the restricted list for Gopher. FTP allows 21 and otherwise applies the same list.
- Credentials in the URL (`ftp://user:pass@host`) are rejected in the first version. If added later, prompt from the main process and never store them in history.
- Listings: try `MLSD`; fall back to `LIST` and show unparsed lines as plain text rather than guessing.
- Files are always downloads, except `text/plain` for a short list of text extensions.

Required tests: PASV reply naming another address is ignored; CRLF in path rejected; oversized and never-ending replies fail cleanly; private addresses refused; a web page cannot trigger a connection.

### Wayback Machine — "View as of…" (Phase 7)

`https://archive.org/wayback/available?url=<url>&timestamp=<YYYYMMDD>` returns the nearest capture. Call it with Electron's `net.fetch` from the main process, then navigate the tab to the returned `https://web.archive.org/…` URL through `navigate(…, 'user-command')`. Privacy: this sends the current URL to the Internet Archive, so it runs only when the user invokes it, never automatically, and the 404 offer must be a button, not an automatic lookup.

### NNTP reader, Finger

Same pattern as Gopher. NNTP needs a multi-command session; apply the control-channel rules from FTP. Finger is one line out, text back: reuse the Gopher client with port 79 allowed for that scheme only.

### Built-in HTML editor ("Edit Page")

Build it in the UI session (trusted origin, own view), not as a page in the web session. Load the page's HTML as inert text into a `contenteditable` surface under a policy that blocks script and network, so opening a hostile page for editing cannot run it. Save through the main process with a save dialog.

### OCR, table extraction, citations (Phase 7)

These read page content. With no preload in tabs (decision A7), obtain content from the main process: `webContents.capturePage()` for OCR regions; a constant extraction script through `executeJavaScript` for tables and metadata, returning plain data that the main process validates. Treat everything returned as untrusted text. Tesseract runs in a utility process, not in the main process.

### Password manager (Phase 3)

Storage through Electron `safeStorage` (OS keystore). The fill action is a registry command requiring `credentials`, so macros and extensions cannot invoke it. Fill only into the top-level page whose origin exactly matches the saved origin; never into frames. This item should be designed and reviewed by a senior model or a person, not delegated as bulk work.

### Android (Phase 9)

See ARCHITECTURE.md. GeckoView gives real extension support and `about:` pages. The command sheet, palette and gestures are driven by the same `catalog.json`. Gopher on Android re-implements the client in Kotlin against the same test cases.
