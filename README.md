# choda-gateway

> One MCP stdio server, many upstreams. CI: Ubuntu + Windows.

## What it is

`choda-gateway` is a single MCP stdio server that aggregates tools from many upstreams — other MCP servers, REST APIs, and CLI commands — and re-exposes them to MCP-native clients (Claude Desktop, Claude Code, GitHub Copilot Chat) through one endpoint, configured by one manifest.

Why one gateway instead of N per-client configs: secrets in one place, tool names governed centrally, observability central, adding a tool = editing one file.

See [ADR-001](docs/knowledge/ADR-001-architecture-overview.md) for the architecture rationale and adapter pattern.

## Why profiles/tags exist

Copilot Chat enforces a hard limit of **128 enabled tools per request**, and even well below that, a long `tools/list` bloats the context window and hurts agent tool-pick accuracy. The gateway addresses this with tags + profiles: each tool declares `tags: string[]`, each profile maps to a tag set, and a gateway instance started with `--profile=<name>` only exposes tools whose tags intersect the profile.

This lets you run multiple gateway instances side-by-side (e.g. `gateway-coding`, `gateway-ops`) — same binary, same manifest, same secrets, different tool subset.

See [ADR-002](docs/knowledge/ADR-002-tag-profile-tool-exposure.md) for the profile mechanism and [ADR-004](docs/knowledge/ADR-004-per-upstream-execution-policy.md) for per-upstream concurrency / timeout / retry policy.

## Requirements

- Node.js **24.14.0** (LTS) — pinned in `.nvmrc` / `engines`
- pnpm **10.33.0** via `corepack enable`
- VS Code **1.100+** (Copilot Chat MCP support)

## Quick start

```powershell
# 1. Install
corepack enable                # if EPERM on Windows: run in elevated shell, or skip if pnpm is already on PATH
pnpm install

# 2. Copy the example config + manifest
Copy-Item gateway.config.example.yaml gateway.config.yaml
Copy-Item tools.example.json tools.json

# 3. Build the CLI bundle
pnpm build

# 4. (Optional, if any tool uses {{secrets.X}}) — init + set the encrypted store
$env:GATEWAY_SECRETS_PASSWORD = "choose-a-strong-passphrase"
node dist/cli.js secrets set LINEAR_API_KEY --value="lin_api_xxx"

# 5. Sanity-check what tools will be exposed
node dist/cli.js tools list --profile=coding

# 6. Start the gateway (stdio MCP server — Claude Code / VS Code attaches to it)
node dist/cli.js start --profile=coding
```

**Secrets:** any string in `tools.json` matching `{{secrets.KEYNAME}}` is resolved from `secrets.enc` at request time. The store is encrypted with libsodium (Argon2id + XChaCha20-Poly1305); the password lives in `GATEWAY_SECRETS_PASSWORD` for the lifetime of the gateway process. Use `node dist/cli.js secrets {list|set|rm}` to manage entries. If the gateway can't find a secret a tool references, it fails fast at startup.

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

## CLI reference

```
choda-gateway start          [--profile=<name>] [--config=<path>]
choda-gateway tools list     [--profile=<name>] [--config=<path>]
choda-gateway secrets list   [--config=<path>]
choda-gateway secrets set <NAME>  [--value=<val>]  [--config=<path>]   # value via stdin if --value omitted
choda-gateway secrets rm  <NAME>  [--config=<path>]
choda-gateway ingest <spec>  --group=<name>  [--auth-profile=<name>]
                             [--out=<path>]  [--base-url=<url>]  [--check]
```

Env:

- `GATEWAY_SECRETS_PASSWORD` — password for the libsodium store. Required when any tool references `{{secrets.X}}`.
- `GATEWAY_PROFILE` — fallback when `--profile` is omitted.

## Dev commands

```powershell
pnpm test          # vitest unit + integration suites (Ubuntu + Windows in CI)
pnpm build         # tsup -> dist/cli.js
pnpm lint          # biome
pnpm format        # biome --write
```

## Current limitations

- **No HTTP downstream client.** The gateway speaks stdio MCP to its clients (Claude Code, Claude Desktop, Copilot Chat). HTTP/SSE client transports are out of scope — see [ADR-001](docs/knowledge/ADR-001-architecture-overview.md).
- **No auth.** The gateway trusts its local process boundary; multi-user / RBAC is out of scope.
- **No log rotation.** Audit JSONL at `auditPath` grows unbounded — rotate externally or wipe periodically.
- **Cross-process secret-store contention.** Running `choda-gateway secrets set` from two terminals concurrently could race the encrypted store. In-process parallel writes are now safe (TASK-976) but cross-process needs filesystem locking — not yet implemented.
- **Single MCP transport.** stdio only. SSE/WebSocket transports follow the same adapter shape but aren't wired.

## OpenAPI ingestion + credential profiles

ADR-006 lets you point `choda-gateway` at an OpenAPI 3.0/3.1 spec and re-expose its operations as MCP tools without hand-writing manifest entries, while declaring auth setup once per company/tenant. See [ADR-006](docs/knowledge/ADR-006-openapi-ingestion-credential-profiles.md) for the full design.

### Layout

```
choda-gateway/
├─ openapi/                # source specs (committed)
│   └─ petstore.yaml
├─ auth-profiles.yaml      # credential profile definitions (committed)
├─ tools/                  # one fragment per spec, emitted by `ingest`
│   └─ example.petstore.json
└─ secrets.enc             # libsodium-encrypted secret values (committed)
```

At startup the gateway loader treats a `toolsPath` that points at a *directory* as a fragment set, glob `*.json` in alphabetical order, and merges into one in-memory manifest. The single-file `tools.json` layout still works.

### Command reference

```
choda-gateway ingest <spec> --group=<name> [--auth-profile=<name>] \
                            [--out=<path>] [--base-url=<url>] [--check]
```

| Flag | Default | Behavior |
|---|---|---|
| `--group` | required | Tool name prefix (`<group>__<action>`) per ADR-005. Must match `^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$`. |
| `--auth-profile` | optional | Profile name from `auth-profiles.yaml`. Per-operation override via the `x-choda-auth-profile` extension. |
| `--out` | `tools/<group>.<spec>.json` | Fragment output path. Parent directory auto-created. |
| `--base-url` | spec's first `servers[].url` | Base URL substituted into the tool's `upstream.url`. |
| `--check` | off | Compare fresh output to the existing fragment; exit 0 if identical, exit 1 + diff summary on drift. Used for CI drift detection. |

### Credential providers (auth-profiles.yaml)

| Type | Use case |
|---|---|
| `bearer-static` | Hardcoded dev token. |
| `api-key` | Static header or query-string key (most public REST). |
| `oauth2-cc` | OAuth2 client_credentials grant (B2B / service-to-service). |
| `cookie-jar` | Forwards a `cookies.txt` file as the `Cookie` header (dev-only APIs, replaces the cancelled TASK-722 PIM cookie-forward path). |
| `exec-script` | Escape hatch — runs a subprocess (`gcloud auth print-access-token`, `az account get-access-token`, custom JWT mints) and parses stdout. |

Inside the profile body, `${secret:KEY}` resolves from `secrets.enc` and `${path:KEY}` resolves from `gateway.config.yaml > paths`. Plaintext values in sensitive fields (`token`, `clientSecret`, `value`) emit a load-time warning — the file is committed, so don't inline secret material.

### Spec extensions

Per-operation overrides recognised by the ingest CLI:

- `x-choda-auth-profile: <name>` — override `--auth-profile` for this operation.
- `x-choda-timeout-ms: <number>` — override the default 30s upstream timeout.

### Walkthrough

```powershell
# 1. Ingest the example spec
pnpm build
node dist/cli.js ingest examples/openapi/petstore.yaml `
  --group=example --auth-profile=example-key `
  --out=examples/tools/example.petstore.json

# 2. Verify the fragment is up to date (use this in CI)
node dist/cli.js ingest examples/openapi/petstore.yaml `
  --group=example --auth-profile=example-key `
  --out=examples/tools/example.petstore.json --check

# 3. Declare the profile in auth-profiles.yaml
Copy-Item examples/auth-profiles.example.yaml auth-profiles.yaml
# Edit to remove the providers you don't need; set ${secret:...} values.

# 4. Point gateway at the tools/ directory
# gateway.config.yaml:
#   toolsPath: ./tools                # directory (merges all *.json)
#   authProfilesPath: ./auth-profiles.yaml

# 5. Start the gateway and call the tool from Claude Code / Copilot Chat
node dist/cli.js start --profile=coding
```

See `examples/openapi/petstore.yaml` for a trivial source spec, `examples/auth-profiles.example.yaml` for one profile per provider type, and `examples/tools/example.petstore.json` for the resulting fragment (kept in sync via `ingest --check` in CI).

### Tool-count ceiling

One real spec can produce 50–100+ tools — well above Copilot Chat's 128-enabled-tools cap. Use tags + profiles ([ADR-002](docs/knowledge/ADR-002-tag-profile-tool-exposure.md)) to expose only the subset each gateway instance needs; the `ingest` CLI auto-tags each tool with `[<op-tags>, <group>]` so a profile mapped to `tags: [<group>]` exposes the whole spec, and finer-grained profiles can target sub-tag sets.

