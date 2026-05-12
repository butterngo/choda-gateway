# Phase 1 smoke test — choda-gateway × 3 MCP clients

**Task:** TASK-697
**Status:** _in progress_ — fill checkboxes as cases pass
**Done when:** 9/9 happy-path cases pass + 3/3 edge cases pass + Butter confirms ≥ 3 days of real workflow without falling back to direct upstream configs.

---

## 1. Why manual

`src/index.test.ts` already proves the wire protocol end-to-end via the MCP SDK's `InMemoryTransport`. What this smoke verifies is what unit tests **cannot** verify:

- Each real client (Claude Desktop / Claude Code / Copilot Chat) actually discovers + invokes the gateway's tools through stdio MCP.
- The Windows-specific spawn + env propagation pipeline behaves under each client's wrapper.
- The audit log + masking behave under real call patterns.

---

## 2. Prerequisites

- Node 22.x (`node -v` ≥ 22.19) — pinned via `package.json` engines.
- pnpm 10.33.0 (`corepack enable && pnpm -v`).
- Repo cloned to a path with **no spaces** (Windows MCP child spawn is fussy).
- `GATEWAY_SECRETS_PASSWORD` set in your shell session (does not need to be in the global env; clients inherit from their parent shell).
- `LINEAR_API_KEY` available (real token, scoped read-only).
- `gh` CLI installed + authenticated (`gh auth status`) — needed for `git__status_summary` / `gh__pr_list`.
- `choda-deck` MCP server reachable at `C:/dev/choda-deck/dist/mcp-server.cjs` (already a Phase 0 dependency).

---

## 3. Gateway build + config

```powershell
pnpm install
pnpm build
# expected: dist/cli.js (~45 KB ESM)

# Copy example files into runtime configs:
copy gateway.config.example.yaml gateway.config.yaml
copy tools.example.json tools.json

# Set secrets (interactive prompt — stdin):
$env:GATEWAY_SECRETS_PASSWORD = "<pick-a-store-password>"
echo $env:LINEAR_API_KEY | node dist/cli.js secrets set LINEAR_API_KEY

# Verify:
node dist/cli.js secrets list           # → LINEAR_API_KEY
node dist/cli.js tools list --profile=coding
# → 3 rows: tasks__task_list / linear__issue_search / gh__pr_list
```

Resolved paths:

- Manifest: `<repo>/tools.json`
- Audit log: `<repo>/audit.jsonl`
- Secret store: `<repo>/secrets.enc`

---

## 4. Client config snippets

> All three configs spawn `node` with the absolute path to `dist/cli.js`. Replace `C:/dev/choda-gateway` with your local path.

### 4.1 Claude Desktop

File: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "choda-gateway": {
      "command": "node",
      "args": [
        "C:/dev/choda-gateway/dist/cli.js",
        "start",
        "--profile=coding",
        "--config=C:/dev/choda-gateway/gateway.config.yaml"
      ],
      "env": {
        "GATEWAY_SECRETS_PASSWORD": "<your-store-password>"
      }
    }
  }
}
```

Restart Claude Desktop after editing.

### 4.2 Claude Code

```bash
claude mcp add choda-gateway \
  --command node \
  --arg C:/dev/choda-gateway/dist/cli.js \
  --arg start \
  --arg --profile=coding \
  --arg --config=C:/dev/choda-gateway/gateway.config.yaml \
  --env GATEWAY_SECRETS_PASSWORD=<your-store-password>
```

Or edit `~/.claude.json` manually under `mcpServers`.

### 4.3 Copilot Chat (VS Code)

File: `<repo>/.vscode/mcp.json` _(top-level key is `servers` — confirmed in CONV-1778389705280-1 Q1, not `mcpServers`)_

```json
{
  "servers": {
    "chodaGateway": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:/dev/choda-gateway/dist/cli.js",
        "start",
        "--profile=coding",
        "--config=C:/dev/choda-gateway/gateway.config.yaml"
      ],
      "env": {
        "GATEWAY_SECRETS_PASSWORD": "<your-store-password>"
      }
    }
  }
}
```

Reload window + open Copilot Chat. Tools appear via `#` mention picker.

---

## 5. Happy-path matrix (9 cases)

Pick a fresh `corrId` after each call by tailing `audit.jsonl`, then run:

```powershell
node scripts/verify-smoke-audit.mjs audit.jsonl <corrId>
```

It will assert: schema-valid, 4 ordered events, single tool/profile, and print upstream + total latency.

| Client | `tasks__task_list` (MCP) | `linear__issue_search` (REST) | `gh__pr_list` (CLI) |
|---|---|---|---|
| **Claude Desktop** | [ ] tool visible · [ ] result · [ ] 4 audit rows · [ ] latency | [ ] tool visible · [ ] result · [ ] 4 audit rows · [ ] latency | [ ] tool visible · [ ] result · [ ] 4 audit rows · [ ] latency |
| **Claude Code** | [ ] tool visible · [ ] result · [ ] 4 audit rows · [ ] latency | [ ] tool visible · [ ] result · [ ] 4 audit rows · [ ] latency | [ ] tool visible · [ ] result · [ ] 4 audit rows · [ ] latency |
| **Copilot Chat** | [ ] tool visible · [ ] result · [ ] 4 audit rows · [ ] latency | [ ] tool visible · [ ] result · [ ] 4 audit rows · [ ] latency | [ ] tool visible · [ ] result · [ ] 4 audit rows · [ ] latency |

### Per-case verification template

For each cell above:

1. **Tool visible** — list the tool from the client UI (Desktop tool picker / `claude mcp list` / Copilot `#` picker). Pasting screenshot or terminal output is fine.
2. **Result** — call the tool with a representative input. Confirm a non-error response. Sample inputs:
   - `tasks__task_list` → `{ "status": "READY", "limit": 3 }`
   - `linear__issue_search` → `{ "query": "gateway" }`
   - `gh__pr_list` → `{ "repo": "butterngo/choda-gateway", "state": "all" }`
3. **Audit rows** — `node scripts/verify-smoke-audit.mjs audit.jsonl <corrId>` exits 0.
4. **Latency** — p95 thresholds from task body:
   - MCP: total `< 50ms`
   - REST: total `< 100ms` (excluding network — for a local mock, < 50ms; for real Linear API, < 1500ms is acceptable, **note as variance** if you go through real network)
   - CLI: total `< 200ms` (gh CLI cold start dominates)

### Sample case write-up

> #### Claude Desktop / tasks__task_list
> - Tool visible: yes — appears as `choda-gateway: tasks__task_list`
> - Result: ✓ — got 3 tasks back
> - Audit: `verify-smoke-audit.mjs` ✓ corrId=corr_01... 4 events ordered correctly · total=23ms · upstream=21ms
> - Latency: 23ms total ✓ (< 50ms target)

---

## 6. Latency aggregation

After running ≥ 3 calls per (client × tool) cell, summarise:

```powershell
node scripts/verify-smoke-audit.mjs audit.jsonl
```

→ prints `upstream.completed latency by type: mcp/rest/cli` with `n / p50 / p95 / max`.

Paste the table here when done:

```
upstream.completed latency by type:
  mcp:  n=? p50=?ms p95=?ms max=?ms
  rest: n=? p50=?ms p95=?ms max=?ms
  cli:  n=? p50=?ms p95=?ms max=?ms
```

---

## 7. Edge cases

### 7.1 Hot-add a tool (ADR-003 — restart-driven discovery)

The gateway does **not** support `SIGHUP` reload (deferred from TASK-696). Client-side refresh happens when the client reconnects after a gateway restart.

Steps:
- [ ] Add a 4th tool to `tools.json` (copy one of the existing entries, change `name`).
- [ ] Restart the client (or the gateway process — depends on client).
- [ ] Verify the new tool appears in the picker.

### 7.2 Profile switch

- [ ] Add an `ops`-tagged tool to `tools.json` (e.g. `ops__ping`).
- [ ] Restart gateway with `--profile=ops`.
- [ ] Verify the `coding` tools are **hidden**, the `ops` tool is **visible**.

### 7.3 Wrong secret

- [ ] Use `gateway secrets set LINEAR_API_KEY` with an obviously invalid value (`bad_token_xxx`).
- [ ] Call `linear__issue_search` from any client.
- [ ] Confirm the error message:
  - Shows up cleanly in the client (no transport-level crash)
  - Does **NOT** contain the literal `bad_token_xxx` (mask should have masked it everywhere)
  - Logs `errKind=http_4xx` in `audit.jsonl` (Linear API will 401 the bad token)

---

## 8. Sign-off

- [ ] 9/9 matrix cells filled and passing
- [ ] 3/3 edge cases passing
- [ ] Latency table pasted (§6)
- [ ] **Butter: ≥ 3 consecutive days** of using the gateway in real workflow without falling back to direct per-upstream MCP configs. Note start + end dates here:

  - Started using gateway: ____-__-__
  - 3-day mark reached: ____-__-__
  - Workflow notes / pain points encountered (if any):

When all four boxes ticked, mark TASK-697 → DONE and Phase 1 ships.
