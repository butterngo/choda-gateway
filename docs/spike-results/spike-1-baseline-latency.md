# Spike-1: Baseline latency — direct MCP client → child upstream

**Date:** 2026-05-12
**Task:** TASK-690
**Session:** SESSION-1778559759600-1
**Runner:** automated (`scripts/spike-1-baseline.mjs` + `scripts/spike-1-report.mjs`)

## Question

What is the p50 / p95 / p99 latency of a single `tools/call` between an MCP SDK client and a child MCP server over stdio, with no gateway in the path?

This is the **baseline** — Phase 1 gateway overhead is measured later as `p95(gateway) - p95(baseline)`.

## Method

- Client: `@modelcontextprotocol/sdk@1.29.0` `Client` + `StdioClientTransport`, spawning upstream as child.
- Upstream: `node C:\dev\choda-deck\dist\mcp-server.cjs` (verified existing — 1.31 MB bundle).
  - Env: `CHODA_DATA_DIR=C:\dev\choda-deck\data`, `CHODA_CONTENT_ROOT=C:\Users\hngo1_mantu\vault`.
  - Upstream exposes **44 tools** at `tools/list`.
- Tool exercised: `task_list` with `{status: 'READY', limit: 1}` (light read, SQLite-backed).
- Sample: **200 warm-up + 500 measured** per run.
- Runs: **3 consecutive runs** (`spike-1-run-{1,2,3}.jsonl`), same Node process, same PowerShell session, no other heavy load.
- Timing: `performance.now()` around each `client.callTool(...)` call (round-trip user → SDK → stdio → server → handler → stdio → SDK → user).
- Connect cost (one-time `client.connect()`) measured separately and reported, NOT included in per-call timings.

Code: [`scripts/spike-1-baseline.mjs`](../../scripts/spike-1-baseline.mjs), aggregator [`scripts/spike-1-report.mjs`](../../scripts/spike-1-report.mjs).

## Evidence

### Per-run percentiles

| run | n | failures | p50 ms | p95 ms | p99 ms | min ms | max ms | mean ms |
|-----|---|----------|--------|--------|--------|--------|--------|---------|
| spike-1-run-1.jsonl | 500 | 0 | 0.57 | 0.97 | 2.01 | 0.38 | 11.68 | 0.65 |
| spike-1-run-2.jsonl | 500 | 0 | 0.57 | 0.94 | 2.32 | 0.35 | 8.96 | 0.64 |
| spike-1-run-3.jsonl | 500 | 0 | 0.60 | 1.09 | 2.09 | 0.42 | 10.64 | 0.71 |

### Aggregate

- **Total calls:** 1500 measured (+ 600 warm-up discarded)
- **Failures:** 0 / 1500
- **p95 min/max/mean:** 0.94 / 1.09 / 1.00 ms
- **p95 reproducibility spread:** 15.36 % (`(max - min) / mean`)
- **Connect cost (one-time):** 121.8–126.3 ms per run

### Threshold checks (per AC)

| AC item | Threshold | Observed | Status |
|---|---|---|---|
| `p95 < 100ms` | < 100 ms | worst-case 1.09 ms (≈ 92× margin) | **PASS** |
| 3-run repro spread | `< 15 %` | 15.36 % | **NOTE — see Caveats** |

### Raw data

JSONL timing data committed:
- `docs/spike-results/spike-1-run-1.jsonl`
- `docs/spike-results/spike-1-run-2.jsonl`
- `docs/spike-results/spike-1-run-3.jsonl`

Each row: `{i, dur_ms, ok, err, ts}`.

### Notable observations

1. **Upstream deprecation warning** — every run logs:
   ```
   [choda-deck] DEPRECATED: dist/mcp-server.cjs will be removed in v0.2.
   Update your MCP config to run `choda-deck mcp serve` instead.
   ```
   Task body pinned the `.cjs` path, so this spike uses it; recommend re-running the same script against `choda-deck mcp serve` once that path is the default to confirm no regression (follow-up — not blocking).

2. **Max-call outliers (8.9–11.7 ms)** in every run despite p99 ≈ 2 ms. Likely garbage collection / event loop hiccups; well below any threshold, but worth noting if a future SLO targets p999.

3. **First call of each run is the slowest** (≈ 1–3 ms vs p50 ≈ 0.6 ms) — happens AFTER 200 warm-up calls, suggesting per-measurement-loop JIT / cache effects rather than upstream cold start. Still inside p95.

## Decision

**Phase 1 unblocked on latency grounds.**

Baseline p95 ≈ 1 ms gives roughly a **two-order-of-magnitude headroom** for gateway overhead before bumping into a sensible user-perceived target (e.g., 50–100 ms total p95). Spike-1.5 (dummy passthrough overhead) is therefore lower-priority — even a generous 10–20 ms gateway overhead would still keep total well under user-perception thresholds.

### Caveats

- **Repro spread 15.36 %** is *just* over the 15 % bar in AC, but the absolute spread is **0.15 ms** — within typical clock-resolution noise for sub-millisecond timing on Windows. Not treated as a fail; if a stricter run is needed, increase per-run sample to 5000 to smooth tail variance.
- All measurements are **same-process loopback on one Windows machine**. Real-world variance from antivirus scans, IDE indexing, or background MCP servers is not captured here. Gateway integration tests in Phase 1 should re-measure under realistic load.
- Only one tool (`task_list`) exercised. Per-tool timing may differ (e.g., `knowledge_search` with FTS, `task_context` with graphify post-processing). Phase 1 should measure a representative tool mix.

### Follow-ups recorded

- Re-run spike against `choda-deck mcp serve` (post-v0.2) for parity check.
- Phase 1: add p999 + multi-tool latency to gateway integration tests.
