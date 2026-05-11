---
type: decision
title: "ADR-001: choda-gateway architecture overview — MCP-only downstream, manifest-driven, 3 upstream adapter"
projectId: choda-deck
workspaceId: choda-gateway
scope: project
refs: []
createdAt: 2026-05-10
lastVerifiedAt: 2026-05-10
---

## Context

VuNgo dùng song song nhiều AI client (Claude Desktop, Claude Code, GitHub Copilot Chat) và muốn **config tool 1 chỗ thay vì N chỗ**. Hiện tại mỗi client phải tự khai báo MCP server / API riêng, dẫn tới:

- Secret rải khắp nơi (rotate token = sửa 3-4 file)
- Tool name xung đột giữa server không có nơi giải quyết
- Không có observability tập trung
- Thêm 1 tool mới = 30-60 phút config 3 chỗ

## Options considered

| Option | Mô tả | Pro | Con |
|---|---|---|---|
| A. Per-client config (status quo) | Mỗi client tự config MCP/API riêng | Không phải build gì | Đau như ở Context |
| B. MCP aggregator only | Wrap nhiều MCP server thành 1 MCP server | Đơn giản, scope nhỏ | Không wrap được REST/CLI — bỏ lỡ phần lớn tool |
| C. Universal gateway dual-protocol (MCP + HTTP) | MCP cho 3 client native + HTTP/OpenAPI cho Gemini | Phục vụ được mọi client | Phức tạp gấp đôi, Gemini OpenAPI compatibility là rủi ro lớn nhất |
| **D. Universal gateway MCP-only (chosen)** | MCP downstream + 3 upstream type (MCP/REST/CLI) wrap qua adapter | Wrap được mọi loại upstream với scope vừa phải | Defer Gemini sang Phase 2 |

## Decision

**Chọn Option D — Universal gateway MCP-only với 3 upstream adapter.**

Cụ thể MVP:
- **Downstream:** 1 protocol = MCP stdio (đủ cho Claude Desktop + Claude Code + Copilot Chat)
- **Upstream:** 3 loại adapter implementing chung interface `UpstreamAdapter`
  - MCP child process (stdio)
  - REST API (HTTPS với secret inject)
  - CLI command (spawn shell)
- **Source of truth:** 1 file `tools.json` (JSON manifest declarative) + 1 file `gateway.config.yaml` + 1 file `secrets.enc` (libsodium-encrypted)
- **Pattern kiến trúc:** Modular monolith, single Node process, không database, file system làm storage
- **Stack:** TypeScript + Node 20 + `@modelcontextprotocol/sdk` + zod + Pino + libsodium-wrappers

### Why

- Gemini là rủi ro cao nhất nếu làm sớm (OpenAPI compatibility chưa verify) → defer cho Phase 2 khi bài MVP đã giải xong
- 3 client target đều native MCP → 1 protocol downstream đủ, đơn giản hơn dual-protocol
- Adapter pattern giữ đường mở: thêm HTTP downstream / SSE upstream sau này không phải đổi core
- Manifest JSON declarative giúp thêm tool = sửa 1 file, không sửa code (giải được pain chính)

## Why not others

| Option | Rejected because |
|---|---|
| A. Per-client config | Không giải bài, đó chính là pain hiện tại |
| B. MCP aggregator only | Bỏ lỡ REST/CLI — phần lớn tool VuNgo cần wrap (Linear, GitHub, gh CLI, kubectl...) là REST/CLI, không phải MCP |
| C. Dual-protocol từ MVP | Gemini OpenAPI compatibility chưa verify, làm song song HTTP + MCP gấp đôi scope mà chưa cần thiết |

## Consequences

- **Good:** Scope MVP còn ~2-3 tuần thay vì 3-4 tuần. Không bị block bởi Gemini compatibility. Adapter pattern cho phép mở dần theo nhu cầu.
- **Bad:** Gemini không dùng được gateway cho tới Phase 2. Người dùng Gemini phải config riêng tools trong giai đoạn này.
- **Risks:**
  - Adapter contract phải đủ tổng quát để sau này thêm HTTP downstream không vỡ existing adapter — mitigated bằng `NormalizedToolCall` / `NormalizedToolResult` ở interface
  - Single-process risk: nếu gateway crash thì 3 client mất tool. MVP chấp nhận, Phase 2 thêm supervisor

## Revisit when

- Cần Gemini hoặc client không native MCP → mở Phase 2 với HTTP + OpenAPI
- Cần cross-machine (laptop ↔ desktop dùng chung gateway) → cần HTTP transport + auth
- Số upstream > 20 và start time chậm → lazy spawn upstream
- Số dev sử dụng > 3 → cần multi-user / RBAC

## Related

- ADR-002: Tag/profile mechanism for tool exposure
- ADR-003: Manifest reload contract
- ADR-004: Per-upstream execution policy
- ADR-005: Tool naming as public API contract
- File analysis: `C:\Users\hngo1_mantu\Documents\Claude\Projects\choda-deck\choda-gateway-analysis.md`
- Conversation: CONV-1778389705280-1
