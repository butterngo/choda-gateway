---
type: learning
title: Refreshing the ichiba session cookie
projectId: choda-deck
workspaceId: choda-gateway
scope: project
refs:
  - path: src/auth/providers/cookie-jar.ts
    commitSha: f98afebc602872e219edaa8e3340cf7e8d3f4f18
  - path: tools.json
    commitSha: f98afebc602872e219edaa8e3340cf7e8d3f4f18
  - path: auth-profiles.yaml
    commitSha: f98afebc602872e219edaa8e3340cf7e8d3f4f18
createdAt: 2026-05-29
lastVerifiedAt: 2026-06-08
---

The `ichiba__*` MCP tools authenticate via the `ichiba-session` cookie-jar profile (`auth-profiles.yaml`), which reads `sensitive_information/ichiba_cookies.txt`. When that file has only comments (initial state) or the `__BFF` cookie expires (~24h), every `ichiba__*` call returns HTTP 401.

This note documents how to refresh the cookie.

## What you actually need

Two cookies from the **`test-api.ichiba.net`** domain — **not** `test-app`:

- `SERVERID` — load-balancer pinning
- `__BFF` — OIDC session token (~944 chars, HttpOnly)

Format in the cookie file: a single line, semicolon-separated.

```
SERVERID=<value>; __BFF=<value>
```

## Why this is the right domain

`tools.json` points `ichiba__userinfo` (and other `ichiba__*` tools) at `https://test-api.ichiba.net/...`. The `__BFF` cookie is set during the OIDC redirect chain when the identity provider posts back to `test-api.ichiba.net/signin-oidc`. Cookies set on `test-app.ichiba.net` are not sent to the API host — using those is the most common mistake.

## Method A — DevTools (manual, fastest)

1. Open `https://test-app.ichiba.net/` in any browser. The site redirects to `test-id.ichiba.net/Connect/Login` (OIDC). Log in. You land back on the app.
2. F12 → **Application** → **Cookies** → select `https://test-api.ichiba.net`.
3. Copy the `Value` column for `SERVERID` and `__BFF`.
4. Open `sensitive_information/ichiba_cookies.txt` and add one line at the bottom (replace any existing data line):
   ```
   SERVERID=<value>; __BFF=<value>
   ```
5. Save. The gateway watches `mtime` (`cookie-jar.ts:46-48`) and reloads on the next tool call — no gateway restart needed.

Alternative for step 2-3: **Network** tab → click any request to `test-api.ichiba.net` → Request Headers → copy the whole `Cookie:` value verbatim and paste it as the data line.

## Method B — Playwright via Claude

Useful when you want to avoid copy-paste of the long `__BFF` value and want the cookie to never appear in a chat transcript.

1. Ask Claude to navigate to `https://test-app.ichiba.net/` via the Playwright MCP server.
2. Type the password yourself in the open browser window — Claude does not see it.
3. Claude calls `context.storageState({ path: 'sensitive_information/_playwright-storage-state.json' })` to dump cookies (including HttpOnly).
4. Claude reads the JSON Node-side, filters to `domain === 'test-api.ichiba.net'`, formats as `name=value; name=value`, overwrites the data line in `ichiba_cookies.txt`, and deletes the temp storage-state file.

Important constraints when scripting this:

- The storage-state dump **must** be written under `sensitive_information/`. The Claude Code auto-mode safety classifier blocks writes of session state to `C:/tmp/` or other paths outside the gateway's authorized credential directory — it reads such writes as credential exfiltration.
- The cookie value never gets echoed back to the conversation. All extraction happens server-side; only the cookie *names* are logged for confirmation.

## When it stops working

- **HTTP 401 returns after a previously working call** → `__BFF` expired. Re-run either method.
- **HTTP 401 immediately after a fresh login** → almost always wrong domain. Verify the cookies came from `test-api.ichiba.net`, not `test-app.ichiba.net`.
- **Gateway didn't pick up the new cookie** → confirm the file's `mtime` actually changed (PowerShell: `(Get-Item ichiba_cookies.txt).LastWriteTime`). `cookie-jar.ts` caches by mtime.

## Parser behavior

`cookie-jar.ts` (`parseCookieFile`) accepts both formats:

- Inline: `name=value; name2=value2` (what we use)
- Netscape tab-separated 7-column format (`curl -c cookies.txt` output)

Comments (`#`) and blank lines are skipped. `forwardHeaders: [cookie]` in `auth-profiles.yaml` controls which header name the gateway uses — currently `Cookie`.
