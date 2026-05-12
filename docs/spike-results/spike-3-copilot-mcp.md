# Spike 3 — Copilot Chat MCP smoke test

**Task:** TASK-691
**Status:** Auto-runner phase ✅ · Butter manual phase ✅
**Auto-runner finished:** 2026-05-12
**Butter manual finished:** 2026-05-12

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

- **VS Code version:** `1.119.0` (from handshake log `clientInfo.version`)
- **MCP protocol version negotiated:** `2025-11-25`
- **GitHub Copilot extension version:** not captured — to be added if quirks recur or behavior changes after a Copilot update. VS Code core version (`1.119.0`) + MCP protocol version (`2025-11-25`) carry the reproducibility weight at the wire level.
- **Trust prompt:** accepted on first reload — server connected successfully (evidenced by `initialize` exchange at `2026-05-12T05:53:02.021Z`)
- **Tool visible in Configure Tools UI:** yes — Butter confirmed `gateway__ping` present
- **Tool visible in `#`-picker:** yes — invoked via `#gateway__ping` from chat
- **Exposed tool name in Copilot UI:** `mcp_gatewayspike_gateway__ping` — Copilot prefixes with `mcp_<serverId>_`; underlying MCP wire-protocol name is unchanged (`gateway__ping`)
- **`tools/call` response payload:**

  ```json
  { "ok": true, "ts": "2026-05-12T05:53:35.937Z", "echo": "pong" }
  ```

  Second call after refresh (Butter sent `message: "ping"`):

  ```json
  { "ok": true, "ts": "2026-05-12T05:56:31.239Z", "echo": "ping" }
  ```

- **`initialize.params.capabilities` (client side, from handshake log):**

  ```json
  {
    "roots": { "listChanged": true },
    "sampling": {},
    "elicitation": { "form": {}, "url": {} },
    "tasks": {
      "list": {},
      "cancel": {},
      "requests": {
        "sampling": { "createMessage": {} },
        "elicitation": { "create": {} }
      }
    },
    "extensions": {
      "io.modelcontextprotocol/ui": {
        "mimeTypes": ["text/html;profile=mcp-app"]
      }
    }
  }
  ```

- **Server capabilities advertised:** `{ "tools": {} }` only — minimal, as expected for hello-world.
- **`_meta` fields on `tools/call`:** Copilot attaches `progressToken`, `vscode.conversationId`, `vscode.requestId`, `traceparent` (W3C trace-context). Worth piping through to gateway logs for correlation in TASK-696.
- **Handshake log excerpt** (full file: `spike-handshake.log`):

  ```text
  2026-05-12T05:53:02.021Z <<< {"jsonrpc":"2.0","id":1,"method":"initialize",...,"clientInfo":{"name":"Visual Studio Code","version":"1.119.0"}}
  2026-05-12T05:53:02.026Z >>> {"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"choda-gateway-spike","version":"0.0.0-spike"}},...}
  2026-05-12T05:53:02.030Z <<< {"jsonrpc":"2.0","method":"notifications/initialized"}
  2026-05-12T05:53:02.030Z <<< {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
  2026-05-12T05:53:02.031Z >>> {"result":{"tools":[{"name":"gateway__ping",...}]},...}
  2026-05-12T05:53:35.936Z <<< {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"_meta":{...,"vscode.conversationId":"..."},"name":"gateway__ping","arguments":{"message":"pong"}}}
  2026-05-12T05:53:35.938Z >>> {"result":{"content":[{"type":"text","text":"{\"ok\":true,\"ts\":\"...\",\"echo\":\"pong\"}"}],"structuredContent":{"ok":true,...}},...}
  ```

- **`__` separator preserved as-is:** ✅ yes. Wire-protocol tool name is exactly `gateway__ping` (no escape, no rename). Copilot UI shows the prefixed form `mcp_gatewayspike_gateway__ping`. Update ADR-005 to note the `mcp_<serverId>_` prefix is a Copilot-side display concern, not a wire-protocol mutation.
- **Refresh path MIN:** **option 1 — just `pnpm build`, no manual restart command**. VS Code/Copilot detects the entry-file change and respawns the MCP server process automatically. Evidence: bundle rewritten ~05:55, fresh `initialize` handshake observed at `2026-05-12T05:56:24.679Z` with the new tool description returned on the subsequent `tools/list`. `MCP: Restart Server` and `MCP: Reset Cached Tools` not needed for description / inputSchema changes.

  Caveat: this is "auto-respawn", not in-process hot-reload — a brand-new server process is started; any in-memory state is lost. Document this distinction in ADR-003.

## Decision

**Verdict:** **Go** for Phase 1.

**Rationale:** Hợp đồng baseline `initialize` / `tools/list` / `tools/call` chạy sạch với Copilot Chat — `servers` key đúng (không phải `mcpServers`), `__` separator giữ nguyên trên wire (UI prefix `mcp_<serverId>_` là cosmetic, gateway không cần xử lý), refresh path chỉ cần `pnpm build` rồi VS Code auto-respawn server (dev loop chấp nhận được). Không phát hiện quirk nào blocking; các finding phụ (auto-respawn ≠ hot-reload, `_meta` mang `traceparent` + `vscode.conversationId`, rich client capabilities) đã document vào Notes/quirks để Phase 1 (TASK-696) consume.

## Notes / quirks (carry into TASK-696)

- **Tool name display vs wire**: Copilot UI prefixes tools with `mcp_<serverId>_`. Gateway should NOT try to compensate by stripping or pre-prefixing — the wire name is what MCP clients negotiate; the UI rendering is Copilot's concern. Update ADR-005 with this clarification.
- **Tracing context available**: every `tools/call` carries `traceparent` (W3C) plus `vscode.conversationId` / `vscode.requestId` in `_meta`. Plumb these into the gateway's structured logs from day one — almost free correlation with VS Code session.
- **Client capability surface is rich**: Copilot advertises `roots`, `sampling`, `elicitation`, `tasks` and an `extensions.io.modelcontextprotocol/ui` mime hint. The hello-world server ignores all of these. TASK-696 should treat these as forward-compatible signals — opt-in features, not hard requirements.
- **Auto-respawn ≠ hot reload**: dev loop is `pnpm build` → done, but each rebuild costs a fresh process. Anything stateful (caches, sessions, in-memory dedupe) must persist outside the process. ADR-003 should call this out explicitly.
- **Selftest stays useful**: `node dist/spike-server.js --selftest` ran in <300 ms and is a cheap CI gate for "the server boots and registers a tool" without touching VS Code.

## Related

- ADR-001 (architecture overview)
- ADR-003 (manifest reload contract — section refresh path)
- ADR-005 (tool naming — `__` separator)
- TASK-688 (repo skeleton, blocker — DONE)
- TASK-696 (router + MCP server entry — will consume learnings)
- TASK-697 (manual smoke for Claude Desktop / Code — deferred)
