---
type: decision
title: "ADR-003: Manifest reload contract — restart server + Reset Cached Tools, không hứa hot-reload realtime"
projectId: choda-deck
workspaceId: choda-gateway
scope: project
refs: []
createdAt: 2026-05-10
lastVerifiedAt: 2026-05-10
---

## Context

Khi user sửa `tools.json` (thêm/sửa/xóa tool), cần có cách "refresh" tool list trên client. MCP spec có `notifications/tools/list_changed` cho phép server push, nhưng:

- VS Code/Copilot có command riêng `MCP: Reset Cached Tools` — tín hiệu rõ rằng tool list không tự refresh trên UI
- Docs VS Code không cam kết `notifications/tools/list_changed` được handle realtime
- Khi config đổi, VS Code cần `(re)start` MCP server để discover tools (có setting experimental `chat.mcp.autostart`)

Nếu gateway gọi tính năng này là "hot-reload" và user kỳ vọng UI refresh ngay → sai contract, gây frustration.

## Options considered

| Option | Mô tả | Pro | Con |
|---|---|---|---|
| A. SIGHUP only (reload trong gateway, push notification) | Gateway watch file + reload + emit `notifications/tools/list_changed` | Tự động phía gateway | Client không reflect realtime → user nghĩ broken |
| B. Restart server only (no in-process reload) | Sửa manifest = giết gateway process, client tự respawn | Đơn giản, không sai contract | Mỗi lần sửa = reconnect, mất state momentary |
| **C. SIGHUP là dev convenience, contract chính thức = restart + Reset Cached Tools (chosen)** | Có hot-reload nội bộ cho dev, nhưng document UX path là restart + reset | Có cả convenience cho dev + contract đúng cho user | Phải document rõ |

## Decision

**Chọn Option C.**

Cụ thể:

1. **Gateway implement SIGHUP handler** để re-load `tools.json` + `gateway.config.yaml` không restart process — coi đây là **dev convenience** khi đang test
2. **Gateway emit `notifications/tools/list_changed`** sau SIGHUP nếu client declare capability — best effort
3. **UX contract chính thức** trong README + docs:
   > Khi sửa `tools.json`, để tool list refresh ở client:
   > 1. Restart gateway server (chấm dứt + cho client respawn)
   > 2. Trong VS Code: chạy command `MCP: Reset Cached Tools` nếu tool không xuất hiện
   > 3. Trong Claude Desktop / Code: restart app nếu cần
4. **Không gọi tính năng SIGHUP là "hot-reload"** trong user-facing docs — chỉ "manifest reload signal" hoặc "dev reload"

### Why

- Tránh đặt sai expectation: nếu gọi "hot-reload" user sẽ nghĩ UI tự refresh
- Restart server là **operational compromise**, không phải bug — accept honestly
- SIGHUP vẫn có value cho dev (test gateway behavior nhanh trong terminal) → giữ lại
- Best-effort `notifications/tools/list_changed` không hại — client nào support thì lợi, không support thì fallback restart

## Why not others

| Option | Rejected because |
|---|---|
| A. SIGHUP + notification only | User sẽ thất vọng vì client không refresh — sai expectation |
| B. Không có SIGHUP | Mất convenience khi dev/test — không lý do gì cắt |

## Consequences

- **Good:** Không có "hot-reload" hứa lèo. User biết rõ phải restart sau khi sửa manifest.
- **Good:** Dev experience vẫn ổn (SIGHUP để test nhanh)
- **Bad:** Mỗi lần thêm tool ở production = momentary disconnect cho client. MVP accept (dev workflow chấp nhận được)
- **Risks:**
  - User vẫn có thể quên restart → tool mới không xuất hiện → debugging confusion. Mitigation: CLI command `gateway tools list` cho phép check tool đã load đúng chưa từ phía gateway

## Revisit when

- MCP spec evolution có cơ chế refresh client-driven mạnh hơn → có thể rút tinh restart pattern
- User base lớn hơn, restart cost cao (vd cross-device gateway phục vụ team) → cần graceful reload thật

## Related

- ADR-001: Architecture overview
- Copilot Chat MCP docs: `MCP: Reset Cached Tools` command
- VS Code experimental setting: `chat.mcp.autostart`
