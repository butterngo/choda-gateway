# ichiba cookie bridge

Keeps `sensitive_information/ichiba_cookies.txt` fresh automatically, so the
gateway's `ichiba-session` profile stops hitting 401 when the `__BFF` session
cookie rotates. No copy-paste, no polling.

## How it works

```
Chrome cookie changes (you log in / token rotates)
   │  chrome.cookies.onChanged fires
   ▼
extension/background.js   reads SERVERID + __BFF (HttpOnly OK — extension privilege)
   │  chrome.runtime.sendNativeMessage
   ▼
host/ichiba_cookie_host.mjs   writes  ichiba_cookies.txt  ("SERVERID=…; __BFF=…")
   │
   ▼
gateway re-reads the file on the next ichiba__* call (it watches mtime)
```

The extension can't write files (Chrome sandbox); the native messaging host does
the disk write. Values are never logged — only cookie names.

## Prerequisites

- Google Chrome (this is wired for Chrome's HKCU registry path).
- `node` on your PATH (the host runs via `run-host.bat` → `node`).

## Install (one time)

1. **Load the extension**
   - `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
     select the `extension/` folder.
   - Copy the extension's **ID** (a 32-char string shown on its card).

2. **Register the native host** (PowerShell, in `host/`)
   ```powershell
   .\register-host.ps1 -ExtensionId <paste-the-32-char-id>
   ```
   This **generates** `com.ichiba.cookie_host.json` from
   `com.ichiba.cookie_host.template.json` (absolute path + your extension's
   origin) and adds the `HKCU\…\NativeMessagingHosts\com.ichiba.cookie_host` key.
   The generated manifest is machine-specific and **gitignored** — only the
   `.template.json` is committed.

3. **Restart Chrome**, then open `https://test-app.ichiba.net/` and log in.
   On login the cookies change → the file is written. Check the extension's
   service-worker console (`chrome://extensions` → *service worker* link) for
   `[ichiba-bridge] cookie file updated: { ok: true, names: [...] }`.

## Verify

- File updated: `(Get-Item ..\..\..\sensitive_information\ichiba_cookies.txt).LastWriteTime`
- Gateway happy: any `ichiba__*` tool returns 200 instead of 401.

## Notes / troubleshooting

- **Cookie file path** is hardcoded in `ichiba_cookie_host.mjs` to
  `C:/dev/choda-gateway/sensitive_information/ichiba_cookies.txt`. Override with
  the `ICHIBA_COOKIE_FILE` env var if your checkout differs.
- **"Specified native messaging host not found"** → the registry key name, the
  manifest `name`, and `HOST_NAME` in `background.js` must all be
  `com.ichiba.cookie_host`; and `allowed_origins` must match your real extension ID.
- **Manifest must be UTF-8 without BOM** — `register-host.ps1` handles this; don't
  re-save it from an editor that adds a BOM.
- **Edge** uses a different registry root (`…\Microsoft\Edge\NativeMessagingHosts`).
  This script targets Chrome only.
- The written file uses the inline `name=value; name=value` format that
  `src/auth/providers/cookie-jar.ts` already parses.
