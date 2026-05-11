---
type: decision
title: "ADR-004: Per-upstream execution policy — concurrency / timeout / retry / sideEffecting trong manifest"
projectId: choda-deck
workspaceId: choda-gateway
scope: project
refs: []
createdAt: 2026-05-10
lastVerifiedAt: 2026-05-10
---

## Context

3 loại upstream (MCP / REST / CLI) có characteristics rất khác nhau về concurrency và safety:

- **MCP child:** thường concurrency-safe (designed cho JSON-RPC concurrent), latency vài ms - vài giây
- **REST API:** read-only thường idempotent, write thường side-effecting; latency network bound
- **CLI:** Windows quoting/escaping, exit code nghèo semantics, side effect implicit, side effect rất khó đoán → mặc định **không trusted**

Nếu gateway dùng global concurrency / timeout policy duy nhất sẽ:
- Quá conservative → MCP fast tool bị bottleneck
- Quá permissive → CLI tool race và gây hỏng state
- Không retry → tool transient fail

## Decision

**Mỗi tool trong `tools.json` declare 4 policy field bắt buộc:**

| Field | Type | Ý nghĩa |
|---|---|---|
| `concurrency` | int 1-32 | Số call tối đa cùng lúc cho cùng 1 tool (per-upstream queue) |
| `timeoutMs` | int 1-600000 | Timeout cho 1 call (gateway cancel + return timeout error) |
| `retryPolicy` | enum `none` / `safe-idempotent` | Có retry khi transient fail không |
| `sideEffecting` | boolean | Tool có side effect không (ảnh hưởng tới retry logic + audit) |

**Defaults theo upstream type** (recommended trong manifest schema):

| Loại upstream | concurrency default | retryPolicy default | sideEffecting default |
|---|---|---|---|
| MCP child | 4 | `none` | (tùy tool) |
| REST read-only (GET) | 8 | `safe-idempotent` | `false` |
| REST write (POST/PUT/PATCH/DELETE) | 4 | `none` | `true` |
| **CLI** | **1 (hard constraint)** | **`none` (hard constraint)** | (tùy tool) |

CLI có **hard constraint** trong JSON Schema (`if type=cli then concurrency=1, retryPolicy=none`) — không cho phép override permissive.

### Why CLI default an toàn cứng

- Windows quoting/escaping rất dễ ra lệnh sai
- Exit code không giàu semantics (success/fail không nói được "transient" vs "permanent")
- Stdout/stderr lẫn nhau, parse fragile
- Side effect implicit (vd `gh pr merge` không thể undo)
- → Mặc định 1 call 1 lúc + không retry là baseline an toàn; user muốn relaxed phải dùng adapter khác (vd REST)

### Field bị reject khỏi v1

- `ordered` (sequential vs parallel) — `concurrency=1` đã đủ enforce sequential, không cần field riêng
- Custom retry backoff schedule — `safe-idempotent` mặc định 3 lần exp backoff, đủ MVP

## Why not others

| Alternative | Rejected because |
|---|---|
| Global policy duy nhất | Không match characteristics khác nhau của 3 loại upstream |
| Per-upstream-instance (không per-tool) | Cùng upstream có thể có tool read và tool write — cần granularity per-tool |
| Schema mở rộng nhiều knob (8-10 field) | Overdesign — Copilot khuyến nghị: field nào không thay đổi routing/execution/safety trong 2 tuần đầu thì chưa đáng có |

## Consequences

- **Good:** Mỗi tool có policy phù hợp; CLI mặc định an toàn cứng tránh footgun
- **Good:** Retry layer chỉ áp dụng cho idempotent tool — không retry mù
- **Bad:** Manifest có 4 field bắt buộc cho mỗi tool — verbose; mitigated bằng template/snippet trong README
- **Risks:**
  - User set sai `sideEffecting=false` cho tool có side effect → retry sai gây duplicate. Mitigation: warn trong audit log nếu tool retry trên `sideEffecting=true`
  - `safe-idempotent` retry có thể che lỗi thật. Mitigation: log mỗi retry attempt trong audit

## Revisit when

- Có tool cần retry policy phức tạp hơn (custom backoff, jitter) → mở `retryPolicy` thành object thay vì enum
- Có tool cần per-input concurrency (vd "không 2 call cùng lúc cho cùng `repo`") → cần input-aware concurrency, defer Phase 2

## Related

- ADR-001: Architecture overview
- ADR-005: Tool naming (sideEffecting ảnh hưởng cách đặt tên — không silently mutate behavior tool có side effect)
