# Security Model

Status: implemented for the Phase 2 shell and the first Phase 3 features, and verified by `npm test` (91 unit tests) and `npm run smoke` (105 end-to-end checks in a real Electron process). Where a control is designed but not built, this document says so.

## What is being protected

1. The user's computer: files, other applications, local network services.
2. The user's browsing data: cookies, history, saved credentials (Phase 3), open pages.
3. The integrity of the browser's own interface: what the address bar and dialogs show.

## Who the attackers are

| Attacker | Controls | Examples |
|---|---|---|
| **Web page** | Any HTML, script, redirect, pop-up, download or header it serves | A malicious site; an ad frame on a good site |
| **Legacy server** | Every byte of a Gopher (later FTP, NNTP) response, and DNS for its own name | A hostile Gopher hole; a DNS name that resolves to `127.0.0.1` |
| **Imported data** | Macro files, keymap files, bookmark imports (Phase 3+) | A "productivity macro pack" from a forum |
| **Local launcher** | Command-line arguments of a packaged build | A shortcut that starts the browser with `--remote-debugging-port` |

Out of scope: an attacker who already runs code as the user, and vulnerabilities in Chromium itself (mitigated by sandboxing and by keeping Electron current).

## Trust boundaries

| Component | Trust | Why |
|---|---|---|
| Main process | Trusted | Holds all authority |
| Browser UI renderer | **Untrusted input, limited authority** | It displays attacker-controlled text (titles, URLs). If it were compromised, it could only ask for catalog commands |
| Tab renderers | Untrusted | Run arbitrary web content |
| Catalog | Trusted, validated at build | Shipped with the app |

## Controls, by threat

### A page tries to reach the browser's privileges

- Tabs have **no preload script and no bridge**. `window.anne`, `require` and `process` do not exist in pages. *(smoke: "web pages get no bridge and no Node access")*
- Every renderer is sandboxed with context isolation; Node integration is off everywhere.
- The UI lives in a separate session (`anne-ui`) whose protocol handler does not exist in the web session. `anne://chrome/…` requested from a tab returns "not found".
- The navigation policy refuses `anne://chrome` as a destination for every initiator, including the browser itself.

### A page tries to reach local files or internal pages

All navigations pass through `decideNavigation` (`app/core/security/url-policy.ts`), which is default-deny:

| Destination | User (typed/command) | Web content |
|---|---|---|
| `http`, `https`, `gopher` | allow | allow |
| `file` | allow | deny, unless the page is itself a local file |
| `anne://pages` | allow | deny, unless coming from another internal page |
| `anne://chrome` | deny | deny |
| `view-source:` of http/https/file/gopher | allow | deny |
| `data:`, `javascript:`, `vbscript:` | deny | deny |
| `mailto`, `tel`, `magnet`, … (11 schemes) | ask, then hand to the OS | ask, one prompt at a time |
| `ftp` | routed to the `legacy.ftp-open` command | same |
| anything else | deny | deny |

It is applied to main-frame navigations, sub-frame navigations (frames get web content only), server redirects, and `window.open` (pop-ups become tabs; the engine never creates a window). Removing the guard makes the smoke test fail, which was confirmed by deliberately removing it.

Subresource requests, which the navigation events do not see, are filtered in `session.webRequest`: internal pages and Gopher are never images, frames, scripts or fetch targets of a page.

### A page tries to reach the local network through a legacy protocol

The browser opens raw TCP connections for Gopher. Without controls a page could use `<img src="gopher://127.0.0.1:6379/_FLUSHALL">` to send commands to local services. Controls, in order:

1. **Top-level only.** Gopher requests that are not a visible page navigation are cancelled. *Confirmed load-bearing: with this rule removed, an image tag on a web page reached the test Gopher server.*
2. **No line smuggling.** A selector containing CR, LF, NUL (or a stray TAB) is rejected, so a URL can only ever send one line.
3. **Restricted ports.** Ports that carry other text protocols (SMTP, Redis, memcached, databases, and the usual browser bad-port list) are refused.
4. **Public addresses only.** The host is resolved once; *every* address returned must be globally routable (loopback, private, link-local, CGNAT, multicast, NAT64 and IPv4-mapped forms are rejected), and the connection goes to that exact address, so a second DNS answer cannot redirect it.
5. **Limits.** 64 MB per response (8 MB for menus and text), idle timeout, overall deadline.

FTP, NNTP and Finger clients must reuse `app/core/security/net-policy.ts` and meet the same five points. See `INTEGRATIONS.md`.

### A legacy server tries to run script or forge UI

- Gopher menus are rendered by the browser into HTML with every server-supplied string escaped. A fuzz test checks that the only tags in the output are ones the renderer writes.
- Every generated page carries `Content-Security-Policy: default-src 'none'; … sandbox`, so even an escaping bug could not run script. HTML documents served over Gopher get the same treatment: displayed, inert. *(smoke: "script in gopher menu text is inert", "HTML served over gopher renders without running script")*
- Images are shown only when their leading bytes are GIF, PNG, JPEG or WebP. Everything else is offered as a download with a sanitized name.
- Links inside menus are followed only if they are `gopher`, `http` or `https`.

### A page tries to compromise the browser's own interface

- UI content policy: `default-src 'none'; script-src 'self'; … require-trusted-types-for 'script'; trusted-types 'none'`. No inline script, no `eval`, and any HTML-string assignment throws. *(smoke: three checks)*
- The UI session blocks every request that is not one of its own files, so a compromised UI cannot send data anywhere.
- Titles and URLs reach the DOM only through `textContent` and `value`.
- The address bar strips embedded credentials (`https://bank.example@evil.example`) and shows hostnames in ASCII form, so look-alike characters are visible as `xn--…`.

### The UI renderer is compromised anyway

It has five functions: run a command, search the palette, read the open list panel, close the overlay, receive state. The main process:

- accepts messages only from the top frame of that window's own UI view at the UI origin;
- validates the shape of every message (`app/core/ipc.ts`), rejecting unknown fields and inherited properties;
- lets the UI claim only the sources `toolbar` or `palette`, never `internal`;
- answers a list request only for the panel that is open in that window (bookmarks, history or downloads);
- then runs the request through the registry like any other invocation.

So the worst a compromised UI can do is what the user could do from the palette and panels. That includes reading bookmarks and history, which the user can also do; it still has no network access to send them anywhere. *(smoke: "a panel cannot be read while it is closed", "another panel cannot be read while this one is open")* *(smoke: "IPC rejects forged source, extra fields, unknown commands, bad argument types")*

### A page asks for device or data permissions

`app/core/security/permissions.ts` is default-deny. Fullscreen and sanitized clipboard writes are allowed. Camera, microphone, location, notifications and similar are `ask`, only for HTTPS origins (or HTTP on this machine), only for the top-level page. USB, serial, HID and MIDI system-exclusive are always denied.

The prompt is a native dialog owned by the main process:

- It names the origin the main process computed from the requesting page, never text the page supplied: "`<origin>` wants to show notifications."
- Default and Escape both mean **Block**.
- Prompts in a window queue, so a page cannot stack dialogs; two requests for the same thing while a prompt is open share one answer.
- Camera and microphone are separate decisions (`media:audio`, `media:video`), so allowing one does not allow the other.
- Embedded frames from other sites are refused without a prompt.
- Answers last until the browser quits; private windows have their own policy, erased when they close; Clear Browsing Data forgets them. Page Info lists what a site was allowed.

*(smoke: six checks, including "an embedded frame from another site cannot ask" and "choosing Block refuses the permission")*

### Downloads

Every download shows a save dialog starting from a sanitized name (no path components, control characters, bidirectional overrides, reserved Windows names or leading dots). Nothing is saved or opened silently.

Files that can run code (`isDangerousFile`: executables, scripts, installers, disk images, macro-enabled Office files and similar) get a warning **before anything is written**. It names the file and the site, says when the connection is unencrypted, and defaults to Cancel. Opening such a file later from the downloads panel asks again. The panel marks these entries. *(smoke: "a program file triggers a warning naming it", "declining the warning saves nothing")*

Save Link As and Save Image As accept only `http` and `https` addresses, so a page cannot use them to copy local files.

### Flash emulation (Ruffle)

Ruffle must run inside the page, because it replaces the page's `<embed>` and `<object>` elements. That is the only place the browser injects code into untrusted pages, so it is constrained:

- Off by default. The user turns it on per tab with **Run Flash Content**; it lasts until the tab closes.
- The injected script is a constant: nothing from the page or user is interpolated into it.
- Ruffle gets the page's privileges and nothing more. It has no bridge to the browser. *(smoke: "the emulator gives the page no route to the browser")*
- Ruffle's files are served from `anne-ruffle://`, which only tabs with Flash turned on may request, so other pages cannot detect the browser by probing for them. *(smoke: two checks)*
- Flash content runs in Ruffle's WebAssembly interpreter, not natively. Its network requests go through the page's own `fetch`, under the page's origin.

Residual risk: a bug in Ruffle is exposed to pages in tabs where the user enabled it. Keep the pinned version current.

### Private windows

Each private window has its own in-memory session: no cookies, storage or cache are shared with normal windows or with other private windows, and nothing is written to the profile. History is not recorded and settings cannot be changed from a private window. On close, the session's storage, cache and authentication cache are cleared, its permission answers forgotten and its downloads cancelled and removed from the list. Downloaded files themselves are kept. *(smoke: seven checks)*

Not covered: a private window does not hide traffic from the network, and the operating system may still page memory to disk.

### Context menus

Link, image and selection data in a right-click come from the page, so they are only ever passed as command arguments. The registry checks their type and length, and the handlers apply the navigation policy: **Open Link in New Tab** opens with the page's authority (`web-content`), so a link to `file:` or an internal page is refused, and no empty tab is left behind. `javascript:` and `data:` links get no link commands. *(smoke: "Open Link cannot be used to reach local files", "a refused link leaves no empty tab behind")*

### Certificates

Page Info shows certificate details recorded by a hook on Chromium's certificate check. The hook only observes: it always returns Chromium's own verdict and can never accept a certificate Chromium rejected. *(smoke: "a self-signed certificate is still rejected")*

### Clearing data

**Clear Browsing Data** offers History Only or Everything. Everything also clears cookies, cache, site storage, the HTTP-auth and host-resolver caches, permission answers and the download list. Bookmarks, settings and downloaded files are kept, and the dialog says so.

### Imported macros and keymaps (Phase 7)

The registry already treats `macro` as a restricted source: no `credentials`, no `external-app`. Keymaps cannot bind plain typing keys outside modal mode. When import is built, imported files must be parsed as data only and re-validated with the build-time validator.

### Startup

A packaged build refuses to start with switches that open a debugging port, disable the sandbox or web security, ignore certificate errors, or redirect traffic (`app/core/security/startup.ts`). Development builds accept `--no-sandbox`, because Chromium requires it when run as root in containers.

## Not built yet, and required before any public release

| Item | Phase | Requirement |
|---|---|---|
| HTTP authentication and client-certificate dialogs | 3 | Prompt must name the origin from the main process, as the permission prompt does |
| Password storage | 3 | Encrypt with the OS keystore through Electron `safeStorage`; never fall back to plain text; registry capability `credentials` already reserved. **Review by a senior model or a person before merge** |
| HTTPS-first for typed addresses with HTTP fallback warning | 3 | Typed names already default to `https://` |
| Packaging hardening | 10 | Electron fuses: disable `runAsNode`, `nodeOptions`, CLI inspect; enable ASAR integrity and `onlyLoadAppFromAsar`. Code signing on Windows and macOS |
| Auto-update | 10 | Signed updates verified against a pinned key; no update over plain HTTP |
| Security review of each new protocol client | 6 | Against the five points above |
| Engine currency | ongoing | Track Electron stable releases; Chromium fixes arrive only through them |

## Known limitations

- On the development machine the end-to-end test runs with Chromium's sandbox disabled, because that machine runs as root. The CI workflow runs the same test as an ordinary user with the sandbox on, and its first run (2026-11-25, Ubuntu 24.04) passed all 46 checks of that version; the run with the Phase 3 additions (2026-11-26) passed all 105.
- Not tested on Windows or macOS.
- `decideNavigation` cannot see navigations Chromium performs entirely inside a renderer without consulting the browser process. None are known for the cases tested.
- No certificate-error override: a bad certificate simply fails to load. That is the safe default, and a Phase 3 design decision whether to ever allow an override.
