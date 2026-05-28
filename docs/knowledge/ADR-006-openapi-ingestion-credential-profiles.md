---
type: decision
title: "ADR-006: OpenAPI ingestion + credential profiles — offline CLI emits manifest fragments, auth resolved at call time by named profile"
projectId: choda-deck
workspaceId: choda-gateway
scope: project
refs: []
createdAt: 2026-05-28
lastVerifiedAt: 2026-05-28
---

## Context

VuNgo maintains many OpenAPI specs across multiple companies (Ichiba, Mantu, …). Each company has its own authentication flow (Ichiba ≈ OAuth2 client_credentials, Mantu ≈ cookie + dev middleware, etc.), and within a company different tenants may share the base flow with a per-tenant header. Goal:

- Take an OpenAPI spec → expose its operations as MCP tools through choda-gateway → usable by Claude Desktop / Code / Copilot Chat.
- Tools from the same company share auth setup — don't redeclare it per tool.
- Adding a new spec ≈ a config change, not a code change.

The gateway already has the runtime plumbing needed: REST upstream adapter (ADR-001), tag/profile filtering for the 128-tool ceiling (ADR-002), per-tool execution policy (ADR-004), naming discipline (ADR-005), libsodium-encrypted secret store (ADR-001). What is missing:

1. **A path from OpenAPI spec → `tools.json` entries** without hand-writing 50+ entries per spec.
2. **An auth abstraction** that lets N tools reference a single named credential setup (so rotating a secret = edit 1 place, not N).
3. **A clear contract about when ingestion happens** — at build time? at gateway startup? on every call? — that doesn't break the manifest-reload contract (ADR-003).

If we don't fix this now, the alternative is hand-writing manifests per endpoint (doesn't scale beyond ~20 endpoints) or inlining auth per tool (secret sprawl, breaks ADR-001's "1 file for secrets" property).

## Options considered

| Option | Mode | Auth model | Pro | Con |
|---|---|---|---|---|
| A. Hand-write manifest entries per endpoint | manual | inline | No new code | Doesn't scale; 1 spec = days of typing; auth duplicated |
| B. Dynamic ingestion at gateway startup | runtime | profile ref | No fragment files; spec is source of truth | Muddies ADR-003 reload contract; spec parsing failures crash startup; no diff/audit trail |
| C. Wrap the whole spec as 1 meta-tool (operation as input) | runtime | profile ref | Tiny manifest | Defeats per-tool tags (ADR-002) and per-tool execution policy (ADR-004); agent UX terrible |
| **D. Offline CLI emits manifest fragments + named credential profiles (chosen)** | build-time | profile ref | Fragments are reviewable, diffable, committable; auth declared once per group; gateway runtime untouched | Need to re-run CLI when spec changes; CLI is new code surface |

## Decision

**Choose Option D — offline CLI + named credential profiles.**

### Layout

```
choda-gateway/
├─ openapi/                          # committed: source specs
│   ├─ ichiba/
│   │   ├─ orders.yaml
│   │   └─ customers.yaml
│   └─ mantu/
│       └─ hoa.yaml
├─ auth-profiles.yaml                # committed: credential profile definitions (no secret values)
├─ tools/                            # committed: manifest fragments emitted by CLI
│   ├─ ichiba.orders.json
│   ├─ ichiba.customers.json
│   └─ mantu.hoa.json
├─ tools.json                        # committed or generated: union of fragments
├─ gateway.config.yaml               # existing
└─ secrets.enc                       # existing — libsodium-encrypted, ADR-001
```

### Ingestion CLI

```
choda-gateway ingest <spec.yaml> \
  --group <name> \
  --auth-profile <profile-name> \
  --out tools/<group>.<spec>.json
```

Per-operation transform rules:

1. **Tool name** = `<group>__<operationId-derived>` per ADR-005. If `operationId` missing, derive from `<verb>_<path>` with slashes collapsed to underscores. CLI fails if collision after derivation.
2. **Upstream type** = `rest`. CLI fails for spec versions other than OpenAPI 3.0/3.1.
3. **Auth** = `authProfile: <profile-name>` (the CLI flag). Per-operation override allowed via `x-choda-auth-profile` extension in the spec.
4. **Tags** = OpenAPI `tags` ∪ `[<group>]`. At least one tag always present (ADR-002).
5. **Execution policy** defaults (ADR-004) chosen by HTTP verb:
   - `GET` → `concurrency=8, retryPolicy=safe-idempotent, sideEffecting=false`
   - `POST/PUT/PATCH/DELETE` → `concurrency=4, retryPolicy=none, sideEffecting=true`
   - `timeoutMs` default `30000`; per-operation override via `x-choda-timeout-ms`.
6. **Input schema** = JSON Schema synthesized from path params + query params + header params + JSON body (`application/json` only in v1).
7. **Description** = OpenAPI `summary` ?? `description` ?? `"${method.toUpperCase()} ${path}"`, truncated to 300 chars.

CLI is **idempotent**: same input → byte-identical output. CLI emits a single fragment file and **does not** mutate `tools.json` directly — a separate `choda-gateway tools build` step merges fragments (or the gateway loader merges at startup; final mechanism left for implementation).

### Credential profiles

`auth-profiles.yaml` is the single source of truth for auth setup. Schema:

```yaml
profiles:
  ichiba-prod:
    type: oauth2-cc
    tokenUrl: https://auth.ichiba.example/oauth/token
    clientId: ${secret:ichiba_prod_client_id}
    clientSecret: ${secret:ichiba_prod_client_secret}
    scope: "orders:read orders:write"

  mantu-dev:
    type: cookie-jar
    cookieFile: ${path:mantu_dev_cookies}
    forwardHeaders: [cookie]

  mantu-tenant-a:
    type: cookie-jar
    cookieFile: ${path:mantu_dev_cookies}
    forwardHeaders: [cookie]
    extraHeaders:
      X-Tenant-Id: tenant-a

  ops-gcloud:
    type: exec-script
    command: ["gcloud", "auth", "print-access-token"]
    headerTemplate: { Authorization: "Bearer {output}" }
    cacheTtlSeconds: 3000
```

Provider set for MVP:

| Provider type | Use case | Cache strategy |
|---|---|---|
| `oauth2-cc` | client_credentials grant (Ichiba-style B2B) | TTL from `expires_in` |
| `cookie-jar` | cookie-based dev auth (Mantu/PIM, replaces the cancelled TASK-722 self-mint path) | Read on each call; reload when file mtime changes |
| `api-key` | header or query key (most public REST) | Static |
| `bearer-static` | hardcoded dev token | Static |
| `exec-script` | escape hatch — runs subprocess, parses headers from stdout JSON or template | TTL declared in profile |

Other OAuth2 grants (auth code, PKCE, device flow) and AWS SigV4 / GCP IAM are explicitly **out of scope for MVP** — added later as new provider types.

### Secret interpolation

Profiles may reference secrets via `${secret:KEY}` (resolved from `secrets.enc`) or paths via `${path:KEY}` (resolved from `gateway.config.yaml > paths`). Plaintext values in `auth-profiles.yaml` are allowed but warned during validation — the file is committed, so it should not contain secret material.

### Runtime contract

- Gateway loads `auth-profiles.yaml` at startup. Unknown profile referenced by any tool → fail fast (same discipline as ADR-002 missing profile).
- For each upstream call, the REST adapter resolves the profile via `CredentialProvider.resolve(ctx) → HeaderMap`, then merges headers into the outbound request. Providers cache as declared above; cache is per-gateway-process.
- Profile reload follows ADR-003: SIGHUP for dev convenience, restart-and-Reset-Cached-Tools for the official UX.

### What the spec must contain (v1 coverage)

Supported:
- HTTP methods: `GET POST PUT PATCH DELETE`
- Request body: `application/json`
- Parameters: `path`, `query`, `header`
- Response body: any (gateway passes through as string + parsed JSON when present)
- `securitySchemes` declared (informational only — actual auth is via profile, not derived from spec)

Not supported in v1 (CLI warns, skips operation):
- `multipart/form-data`, `application/octet-stream`, file upload/download
- Streaming responses (SSE, chunked text streams)
- `callbacks`, `webhooks`, `links`
- OpenAPI 2.0 (Swagger)
- Recursive / `oneOf` polymorphic schemas beyond depth 3 (warn, flatten to `object`)

### Why

- **Static fragments** match ADR-001's manifest-driven philosophy and ADR-003's reload contract — no surprise startup failures from malformed specs in prod; PR review catches changes.
- **Profile names as references** keep `tools.json` slim and let secret rotation stay in `secrets.enc` only.
- **Flat profile list** (no inheritance) is enough for the realistic profile count (10–20). Inheritance is appealing but a YAML-anchors footgun at this scale.
- **Provider plugin shape** keeps `exec-script` as the escape hatch — any auth flow we haven't modelled is still reachable without core changes.
- **CLI idempotence** lets ingestion be re-run in CI and the diff be the review.

## Why not others

| Option | Rejected because |
|---|---|
| A. Hand-written entries | Linear cost in endpoint count; auth duplication; this is the pain we're fixing |
| B. Runtime ingestion | Breaks ADR-003 reload contract; spec parse errors become startup crashes; no audit trail for manifest changes |
| C. One meta-tool per spec | Loses per-tool tags (ADR-002), per-tool execution policy (ADR-004), and per-tool approval state on the client; bad agent UX (huge enum input) |
| Inline auth per tool | Secret sprawl; defeats "1 place for secrets" from ADR-001; rotation pain |
| Derive auth from spec `securitySchemes` only | Specs lie / are stale; real auth at runtime often differs from declared scheme (especially in internal APIs); profile-as-source-of-truth is honest |
| Auth profile inheritance / mixins | Over-design for current profile count; revisit at 50+ |

## Consequences

- **Good:** Adding a spec = `ingest` CLI + 1 fragment file in PR. Adding a new auth setup = 1 entry in `auth-profiles.yaml`. Rotating a secret = edit `secrets.enc`, no manifest touch.
- **Good:** Tools auto-inherit tag/profile filtering (ADR-002) and execution policy (ADR-004) defaults without manual entry.
- **Good:** The cancelled TASK-722 use case (cookie-forwarding to PIM) is covered by `cookie-jar` provider — no PIM-side middleware coupling required.
- **Bad:** Spec change → re-run CLI → review fragment diff. Not zero-cost. Mitigated by CI check that fragment matches `ingest` output (drift detector).
- **Bad:** Two languages of truth exist transiently — `openapi/*.yaml` and `tools/*.json`. The fragment is the runtime authority; spec is the source.
- **Bad:** v1 coverage is intentionally narrow (no multipart, no streaming). Some specs will have unsupported operations the CLI skips with a warning — user must know to check.
- **Risks:**
  - `exec-script` provider is a code execution surface. Mitigation: profile schema requires explicit `command` array (no shell string), audit log records every invocation.
  - Manifest fragments can drift from spec if CLI not re-run. Mitigation: CI job runs `ingest --check` and fails the PR if the fragment is stale.
  - Operation count explosion (one spec → 100+ tools) hits the 128 limit. Mitigation: tag/profile filter (ADR-002) is already the answer; document the pattern in the README.
  - Per-tenant profile fan-out (Mantu has N tenants → N profiles) becomes verbose. Mitigation: accept the verbosity for MVP; revisit "profile templating" when N > 10.

## Revisit when

- More than ~50 credential profiles exist → introduce inheritance or templating.
- Need an auth flow not covered by the 5 providers (e.g. AWS SigV4, mTLS, device flow) → add a new provider type, don't reach for `exec-script` long-term.
- Specs commonly include streaming or multipart operations needed for actual work → expand v1 coverage; may require MCP transport adjustments.
- Manifest fragment drift becomes a frequent bug → consider runtime ingestion behind a feature flag, paying ADR-003 cost knowingly.
- Need to expose the same spec under multiple auth profiles in the same gateway (e.g. ichiba-prod vs ichiba-staging) → either run multiple gateway instances (matches ADR-002 multi-instance pattern) or extend the CLI to emit per-environment fragments.

## Related

- ADR-001: Architecture overview (REST upstream adapter, secrets.enc, manifest-driven philosophy)
- ADR-002: Tag/profile mechanism (handles the per-spec tool count explosion)
- ADR-003: Manifest reload contract (why ingestion is offline, not runtime)
- ADR-004: Per-upstream execution policy (defaults by HTTP verb)
- ADR-005: Tool naming convention (`<group>__<action>`)
- Cancelled TASK-722: cookie-forwarding to PIM — supersedes that flow via `cookie-jar` provider
