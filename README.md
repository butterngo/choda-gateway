# choda-gateway

> MCP server làm aggregator/proxy cho các connector backend (Jira, Postgres, Playwright, ...) — **không gộp vào choda-deck**.

## Why separate from choda-deck

- **Identity rõ ràng**: `choda-deck` = "memory + orchestration layer" (tasks, inbox, knowledge, conversation). `choda-gateway` = "connector infrastructure" (auth, routing, observability). Hai concern khác nhau hoàn toàn.
- **Attack surface**: choda-deck chỉ đọc/ghi SQLite local. Gateway phải hold credentials (Jira tokens, Postgres passwords) → tăng risk surface nếu gộp.
- **Bundle size**: gateway cần network/auth code, không nên bundle vào npm package memory layer.
- **Coexist**: hai MCP server chạy cùng trong `.claude.json`.

## Architecture (proposed)

```
Client (Copilot / Claude Code / Claude Desktop)
  ↓ stdio MCP
choda-gateway (1 endpoint)
  ↓ proxy / route
Real MCP servers (Jira, Postgres, Playwright, ...)
```

## Status

🚧 **Pre-research** — chưa quyết scope.

### Pain points cần ưu tiên (chọn 1+)

- [ ] **(a) Config dedup** — Copilot/Claude Code/Claude Desktop hiện tại config 3 nơi → 1 endpoint. *DX problem, có thể symlink config giải 80%.*
- [ ] **(b) Centralized observability** — log mọi MCP call qua 1 chỗ, debug dễ.
- [ ] **(c) Auth/credential management tập trung** — vault-style, rotate token 1 chỗ.
- [ ] **(d) Routing logic** — Jira call từ project A đi instance khác project B.
- [ ] **(e) Personal AI hub vision** — mọi call đi qua gateway có context inject. *Tham vọng dài hạn.*

## Research checklist

- [ ] Khảo sát existing tools: `mcp-proxy`, `mcp-gateway`, một số aggregator OSS — tránh reinvent wheel.
- [ ] Xác định pain chính (a/b/c/d/e) — quyết định scope. (a) làm 1 ngày, (e) là cả subsystem.
- [ ] Threat model cho credential storage (nếu chọn c/d/e).
- [ ] Decide: build mới hay fork existing.
- [ ] Spike: 1 connector (Jira) qua gateway, đo overhead vs direct.

## ADRs

- ADR-001 — Identity & separation rationale (kế hoạch).

## Refs

- `choda-deck/INBOX-086` — origin idea (07/05/2026).
- `choda-deck` — sister project (memory + orchestration layer).

## License

Private. TBD nếu chuyển OSS.
