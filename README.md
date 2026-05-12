# choda-gateway

> Status: **Phase-0** (design + spike). Phase-1 implementation in progress.

## What it is

`choda-gateway` is a single MCP stdio server that aggregates tools from many upstreams — other MCP servers, REST APIs, and CLI commands — and re-exposes them to MCP-native clients (Claude Desktop, Claude Code, GitHub Copilot Chat) through one endpoint, configured by one manifest.

Why one gateway instead of N per-client configs: secrets in one place, tool names governed centrally, observability central, adding a tool = editing one file.

See [ADR-001](docs/knowledge/ADR-001-architecture-overview.md) for the architecture rationale and adapter pattern.

## Why profiles/tags exist

Copilot Chat enforces a hard limit of **128 enabled tools per request**, and even well below that, a long `tools/list` bloats the context window and hurts agent tool-pick accuracy. The gateway addresses this with tags + profiles: each tool declares `tags: string[]`, each profile maps to a tag set, and a gateway instance started with `--profile=<name>` only exposes tools whose tags intersect the profile.

This lets you run multiple gateway instances side-by-side (e.g. `gateway-coding`, `gateway-ops`) — same binary, same manifest, same secrets, different tool subset.

See [ADR-002](docs/knowledge/ADR-002-tag-profile-tool-exposure.md) for the profile mechanism and [ADR-004](docs/knowledge/ADR-004-per-upstream-execution-policy.md) for per-upstream concurrency / timeout / retry policy.

## Requirements

- Node.js **22.19.0** (LTS) — pinned in `.nvmrc` / `engines`
- pnpm **10.33.0** via `corepack enable`
- VS Code **1.100+** (Copilot Chat MCP support)

## Quick start

```powershell
# Setup (Phase-0 verified — these 4 steps work today)
corepack enable                # if EPERM on Windows: run in elevated shell, or skip if pnpm is already on PATH
pnpm install
Copy-Item gateway.config.example.yaml gateway.config.yaml
Copy-Item tools.example.json tools.json

# Phase-1 (deferred — CLI binary lands in TASK-696):
# pnpm build
# node dist/cli.js start --profile=coding
#
# Then add .vscode/mcp.json (see "How to attach" below) and reload VS Code.
```

**Secret loading:** Phase-1 will resolve `{{secrets.X}}` placeholders. The libsodium-backed encrypted store (TASK-692) is deferred to Phase 2 — local-only use does not warrant the complexity. Phase-1 reads secrets from `process.env`; the strategy will be finalised in TASK-694.

## Minimal config

`tools.example.json` ships three tools — one of each upstream kind — to make the shape concrete:

| Tool name | Upstream | Tags | Notes |
|---|---|---|---|
| `tasks__task_list` | MCP child (`choda-deck`) | `coding`, `planning` | Re-exposes a remote MCP tool |
| `linear__issue_search` | REST `POST` to Linear GraphQL | `coding`, `planning` | Uses `{{secrets.LINEAR_API_KEY}}` |
| `gh__pr_list` | CLI `gh pr list` | `coding` | CLI is hard-locked to `concurrency=1`, `retryPolicy=none` |

`gateway.config.example.yaml` defines profiles `coding`, `ops`, `all`.

Tool names follow `<namespace>__<action>` — namespace identifies the upstream domain, action is `verb` or `verb_object`. Renaming a tool breaks every client that has approved it; see [ADR-005](docs/knowledge/ADR-005-tool-naming-as-public-contract.md).

Both example files validate against their JSON Schemas — `tools.schema.json` and `audit-entry.schema.json`.

## How to attach to VS Code MCP

Copy `.vscode/mcp.json.example` to `.vscode/mcp.json` and adjust the path to the built `cli.js`. The example registers two gateway instances (one per profile) to demonstrate the multi-instance pattern from ADR-002.

```jsonc
{
  "servers": {
    "gateway-coding": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/cli.js", "start", "--profile=coding"]
    }
  }
}
```

The top-level key is **`servers`** (the current VS Code MCP spec), not `mcpServers`.

When you edit `tools.json` and the new tool doesn't show up in Copilot Chat:

1. Restart the gateway server (let VS Code respawn it), and
2. Run **`MCP: Reset Cached Tools`** from the command palette.

The gateway also implements a `SIGHUP` reload as a dev convenience, but client UIs do not refresh on `notifications/tools/list_changed`, so the official refresh path is restart + reset. See [ADR-003](docs/knowledge/ADR-003-manifest-reload-contract.md).

## Dev commands + current limitations

```powershell
pnpm test          # vitest unit + integration suites
pnpm build         # tsup -> dist/
pnpm lint          # biome
# pnpm secrets ... # Phase-1 (TASK-694) — strategy TBD, see Quick start
```

Current limitations (Phase-0/1 MVP scope):

- **HTTP downstream not implemented** — only stdio MCP downstream is supported. Gemini and other non-MCP clients are deferred to Phase 2 (revisit when needed; see ADR-001).
- **Tested on Windows only.** Spike-1 latency (p95 ≈ 1ms) and Spike-2 crash isolation were validated on Windows 11 + Node 22; Linux signal-payload parity is deferred to Phase-1 CI.
- **No auth.** The gateway trusts its local process boundary; multi-user / RBAC is out of scope.
- **No log rotation.** Audit JSONL grows unbounded — rotation is Phase 2.
- **No encrypted secret store.** Phase-1 reads from `process.env`. See "Quick start" for the deferral rationale.

For supervisor strategy (restart vs fail-closed on upstream crash, keyed off `sideEffecting`), see the Spike-2 report under `docs/spike-results/`. ADR-006 will formalise it once Phase-1 lands the supervisor module.
