---
type: learning
title: Auto-refreshing the ichiba cookie via a Chrome native-messaging bridge
projectId: choda-deck
workspaceId: choda-gateway
scope: project
refs:
  - path: scripts/chrome-cookie-bridge/extension/background.js
    commitSha: fea44bc85804c6491ed23ebb4369f4ea90c1a4dc
  - path: scripts/chrome-cookie-bridge/host/ichiba_cookie_host.mjs
    commitSha: fea44bc85804c6491ed23ebb4369f4ea90c1a4dc
  - path: src/auth/providers/cookie-jar.ts
    commitSha: fea44bc85804c6491ed23ebb4369f4ea90c1a4dc
createdAt: 2026-05-29
lastVerifiedAt: 2026-05-29
---

The `ichiba-session` cookie-jar profile reads `sensitive_information/ichiba_cookies.txt`.
That file goes stale when the HttpOnly `__BFF` session cookie rotates (~24h), and every
`ichiba__*` tool then returns HTTP 401. The manual refresh methods are in
[refreshing-the-ichiba-session-cookie.md](./refreshing-the-ichiba-session-cookie.md)
(Method A = DevTools copy, Method B = Playwright dump). This note documents **Method C —
a Chrome extension that keeps the file fresh automatically**, under
`scripts/chrome-cookie-bridge/`.

## Why an extension (and not "just read Chrome's cookie DB")

Chrome ≥127 uses **App-Bound Encryption** on its cookie store, so decrypting
`…\User Data\Default\Network\Cookies` off disk no longer works (the test host runs
Chrome 148). And `__BFF` is **HttpOnly**, so page JS / `document.cookie` can't see it
either. The only supported way to read the value programmatically is the extension
`chrome.cookies` API, which is privileged and returns HttpOnly values — the same
mechanism Postman Interceptor uses.

## The chain

```
Chrome sets/updates a cookie (login or token rotation)
   │  chrome.cookies.onChanged fires
   ▼
extension/background.js   reads SERVERID + __BFF for test-api.ichiba.net
   │  chrome.runtime.sendNativeMessage("com.ichiba.cookie_host", { cookies })
   ▼
host/ichiba_cookie_host.mjs   writes ichiba_cookies.txt  ("SERVERID=…; __BFF=…")
   │
   ▼
gateway re-reads the file on the next ichiba__* call (cookie-jar.ts watches mtime)
```

The extension can't write files (Chrome sandbox); the **native messaging host** does the
disk write. Values are never logged — only cookie names.

## Key facts that bite

- **`onChanged` is future-only.** It won't surface the value already in the jar, so
  `background.js` also calls `chrome.cookies.get` on `onStartup`/`onInstalled`.
- **MV3 service worker is ephemeral.** The `onChanged` listener must be registered at the
  top level of `background.js` so Chrome knows to wake the worker for that event.
- **`sendNativeMessage` is connectionless** — Chrome spawns the host, sends one
  length-prefixed JSON message, reads one reply, and the host exits. The host reads a
  4-byte LE length + UTF-8 JSON body; it must flush its reply *before* exiting.
- **Right domain.** Cookies must come from `test-api.ichiba.net`, not `test-app` — same
  gotcha as the manual methods.

## Setup (one time, Windows + Chrome)

1. `chrome://extensions` → Developer mode → **Load unpacked** → `…/chrome-cookie-bridge/extension`. Copy the 32-char extension ID.
2. `host\register-host.ps1 -ExtensionId <id>` — patches the host manifest (absolute
   `path` + `allowed_origins`, written UTF-8 **without BOM** — Chrome rejects a BOM) and
   adds `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ichiba.cookie_host`.
3. Restart Chrome, log into `https://test-app.ichiba.net/`. The file is written on login
   and on every later rotation.

> `register-host.ps1` rewrites `com.ichiba.cookie_host.json` with machine-specific values
> (absolute path + the local extension ID). Keep those out of version control — commit
> only a placeholder template of that manifest.

## When it doesn't fire

- **"native messaging host not found"** → the registry key name, manifest `name`, and
  `HOST_NAME` in `background.js` must all be `com.ichiba.cookie_host`; `allowed_origins`
  must equal the real extension ID.
- **File never updates** → check the extension's service-worker console for
  `[ichiba-bridge] …`; confirm `node` is on PATH (the host runs via `run-host.bat`).
- **Still 401 after a write** → confirm the file mtime changed and the cookies came from
  `test-api.ichiba.net`.

## Relation to the manual methods

Method C supersedes the day-to-day need for A/B once installed, but A (DevTools) remains
the zero-infra fallback when the extension isn't loaded (e.g. a fresh machine).
