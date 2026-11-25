# Security Model

Status: implemented for the Phase 2 shell and verified by `npm test` (66 unit tests) and `npm run smoke` (46 end-to-end checks in a real Electron process). Where a control is designed but not built, this document says so.

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

It has four functions: run a command, search the palette, close the palette, receive state. The main process:

- accepts messages only from the top frame of that window's own UI view at the UI origin;
- validates the shape of every message (`app/core/ipc.ts`), rejecting unknown fields and inherited properties;
- lets the UI claim only the sources `toolbar` or `palette`, never `internal`;
- then runs the request through the registry like any other invocation.

So the worst a compromised UI can do is what the user could do from the palette. *(smoke: "IPC rejects forged source, extra fields, unknown commands, bad argument types")*

### A page asks for device or data permissions

`app/core/security/permissions.ts` is default-deny. Fullscreen and sanitized clipboard writes are allowed. Camera, microphone, location, notifications and similar are `ask`, only for HTTPS origins (or HTTP on this machine), only for the top-level page. USB, serial, HID and MIDI system-exclusive are always denied. **No prompt UI exists yet, so every `ask` currently resolves to deny.** Building the prompt is Phase 3 work; the policy does not change.

### Downloads

Every download shows a save dialog starting from a sanitized name (no path components, control characters, bidirectional overrides, reserved Windows names or leading dots). Nothing is saved or opened silently. `isDangerousFile` identifies executable types for the Phase 3 downloads UI to warn on; that warning is not built yet.

### Flash emulation (Ruffle)

Ruffle must run inside the page, because it replaces the page's `<embed>` and `<object>` elements. That is the only place the browser injects code into untrusted pages, so it is constrained:

- Off by default. The user turns it on per tab with **Run Flash Content**; it lasts until the tab closes.
- The injected script is a constant: nothing from the page or user is interpolated into it.
- Ruffle gets the page's privileges and nothing more. It has no bridge to the browser. *(smoke: "the emulator gives the page no route to the browser")*
- Ruffle's files are served from `anne-ruffle://`, which only tabs with Flash turned on may request, so other pages cannot detect the browser by probing for them. *(smoke: two checks)*
- Flash content runs in Ruffle's WebAssembly interpreter, not natively. Its network requests go through the page's own `fetch`, under the page's origin.

Residual risk: a bug in Ruffle is exposed to pages in tabs where the user enabled it. Keep the pinned version current.

### Imported macros and keymaps (Phase 7)

The registry already treats `macro` as a restricted source: no `credentials`, no `external-app`. Keymaps cannot bind plain typing keys outside modal mode. When import is built, imported files must be parsed as data only and re-validated with the build-time validator.

### Startup

A packaged build refuses to start with switches that open a debugging port, disable the sandbox or web security, ignore certificate errors, or redirect traffic (`app/core/security/startup.ts`). Development builds accept `--no-sandbox`, because Chromium requires it when run as root in containers.

## Not built yet, and required before any public release

| Item | Phase | Requirement |
|---|---|---|
| Permission prompt UI | 3 | Prompt must name the origin from the main process, not from page-supplied text |
| HTTP authentication and client-certificate dialogs | 3 | Same origin-display rule |
| Password storage | 3 | Encrypt with the OS keystore through Electron `safeStorage`; never fall back to plain text; registry capability `credentials` already reserved. **Review by a senior model or a person before merge** |
| Download warnings for executable types | 3 | Use `isDangerousFile` |
| HTTPS-first for typed addresses with HTTP fallback warning | 3 | Typed names already default to `https://` |
| Packaging hardening | 10 | Electron fuses: disable `runAsNode`, `nodeOptions`, CLI inspect; enable ASAR integrity and `onlyLoadAppFromAsar`. Code signing on Windows and macOS |
| Auto-update | 10 | Signed updates verified against a pinned key; no update over plain HTTP |
| Security review of each new protocol client | 6 | Against the five points above |
| Engine currency | ongoing | Track Electron stable releases; Chromium fixes arrive only through them |

## Known limitations

- The end-to-end test ran here with Chromium's sandbox disabled, because this build machine runs as root. The app requests the sandbox for every renderer; the CI workflow runs the same test with the sandbox on. Until that CI run is green, sandboxed operation is configured but not demonstrated.
- Not tested on Windows or macOS.
- `decideNavigation` cannot see navigations Chromium performs entirely inside a renderer without consulting the browser process. None are known for the cases tested.
- No certificate-error override: a bad certificate simply fails to load. That is the safe default, and a Phase 3 design decision whether to ever allow an override.
