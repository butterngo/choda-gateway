# Spike 3 — Copilot Chat MCP smoke test

**Task:** TASK-691
**Status:** Auto-runner phase ✅ complete · Butter manual phase ⏳ pending
**Auto-runner finished:** 2026-05-12

## Question

Liệu Copilot Chat (VS Code) có chạy được MCP baseline `initialize` / `tools/list` / `tools/call` với hello-world server không, và có quirk nào lạ (config key, tool naming `__`, refresh path) cần document trước khi vào Phase 1?

## Method

### Auto-runner phase (done)

1. Build hello-world MCP stdio server `src/spike-server.ts` expose tool `gateway__ping({message?}) → {ok, ts, echo}`, stderr handshake log → `spike-handshake.log`.
2. Verify build artefact `dist/spike-server.js` size > 0.
3. Run `node dist/spike-server.js --selftest` and capture elapsed time + stderr `MCP server ready` pattern.
4. Write `.vscode/mcp.json` with top-level key `servers` (NOT `mcpServers`), `type: "stdio"`, `command: node`, `args: ["${workspaceFolder}/dist/spike-server.js"]`.
5. Verify config shape via PowerShell `ConvertFrom-Json | Get-Member -Name servers`.
6. Init empty `spike-handshake.log` ready to be appended by server on first Copilot connection.

### Butter manual phase (pending)

1. Reload VS Code (Cmd+Shift+P → Developer: Reload Window) and accept the MCP trust prompt.
2. Confirm tool `gateway__ping` appears in BOTH Configure Tools UI and `#`-picker.
3. From Copilot Chat: `use gateway__ping with message hello` → assert response object contains `ok: true`, `ts` ISO8601, `echo: "hello"`.
4. Inspect `spike-handshake.log` for `"method":"initialize"`, `"method":"notifications/initialized"`, ≥ 1 `"method":"tools/call"`.
5. Refresh path test — edit tool description, re-run `pnpm build`, then try in order: (a) no restart, (b) `MCP: Restart Server`, (c) `MCP: Reset Cached Tools`. Document which is the MIN to pick up the new description.
6. Confirm `__` separator survives untouched in the rendered tool name (no rename / no reject).

## Evidence

### Auto-runner

- `dist/spike-server.js` size: **3405 bytes**
- Selftest: **exit=0, elapsed=287 ms**, stderr matched `MCP server ready`
- `.vscode/mcp.json`: `has_servers=True`, `has_mcpServers=False`, `servers.gatewaySpike.type=stdio`
- `spike-handshake.log`: file exists, empty (ready)
- Tool name freeze: `gateway__ping` (double underscore per ADR-005)

### Butter manual

- **VS Code version:** <!-- BUTTER: paste `code --version` output -->
- **GitHub Copilot extension version:** <!-- BUTTER: paste from Extensions tab -->
- **Trust prompt screenshot:** <!-- BUTTER: attach or link -->
- **Tool visible in Configure Tools UI:** <!-- BUTTER: screenshot or describe -->
- **Tool visible in `#`-picker:** <!-- BUTTER: screenshot or describe -->
- **`tools/call` response payload:** <!-- BUTTER: paste literal JSON returned in chat -->
- **`initialize.params.capabilities` (client side, from handshake log):** <!-- BUTTER: paste JSON block -->
- **Handshake log excerpt:** <!-- BUTTER: paste 5–10 lines including initialize / notifications/initialized / tools/list / tools/call -->
- **`__` separator preserved as-is:** <!-- BUTTER: yes / no + observed name -->
- **Refresh path MIN:** <!-- BUTTER: option 1 / 2 / 3 + notes on what each did -->

## Decision

<!-- BUTTER: Go / no-go for Phase 1 + rationale ≥ 2 câu.
Examples to address:
- Did `servers` key work without quirks?
- Did `__` survive intact?
- Is the refresh path acceptable for dev iteration?
-->

## Notes / quirks

<!-- BUTTER: any surprise behavior, error messages, UI weirdness, etc. Worth keeping for TASK-696 implementation. -->

## Related

- ADR-001 (architecture overview)
- ADR-003 (manifest reload contract — section refresh path)
- ADR-005 (tool naming — `__` separator)
- TASK-688 (repo skeleton, blocker — DONE)
- TASK-696 (router + MCP server entry — will consume learnings)
- TASK-697 (manual smoke for Claude Desktop / Code — deferred)
