---
type: decision
title: "ADR-005: Tool naming là public API contract — namespace__action, không version trong tên"
projectId: choda-deck
workspaceId: choda-gateway
scope: project
refs: []
createdAt: 2026-05-10
lastVerifiedAt: 2026-05-10
---

## Context

Khi tool đã expose qua gateway cho client (Claude Desktop / Code / Copilot Chat), tên tool trở thành **public surface**:

- Prompt habits: user và agent quen gọi tool theo tên
- Saved workflows / snippets reference tool name
- Trust state phía client (approval) gắn với tool name
- Documentation reference tool name

→ **Rename = breaking change** với tất cả những thứ trên. Cần discipline naming ngay từ đầu để tránh phải rename về sau.

## Decision

**Naming convention:**

```
<namespace>__<verb_or_domain_action>
```

Cụ thể rules:

1. **Namespace prefix** (lowercase, snake_case, max 32 char):
   - Match upstream identity (vd `tasks__`, `linear__`, `gh__`, `git__`, `kubectl__`)
   - Không match version (đừng dùng `linear_v2__`)
   - Reserve `gateway__` cho meta-tool của gateway (vd `gateway__list_profiles`)

2. **Separator:** `__` (double underscore)
   - Hợp lệ theo MCP spec (`A-Za-z0-9_.-` cho phép)
   - VuNgo đã chốt; **đổi sau = vỡ mọi tool** → freeze từ Phase 0

3. **Action part** (snake_case, max 64 char):
   - Verb hoặc verb_object: `create`, `list`, `pr_merge`, `issue_search`
   - Không encode version: KHÔNG dùng `task_create_v2`
   - Không encode "internal" / "experimental" trong tên

4. **Breaking behavior change → tool mới**:
   - Nếu logic tool đổi đáng kể (input shape, output shape, side effect) → expose tool mới với tên khác (vd `task_create_v2`) thay vì silently mutate `task_create`
   - Cũ deprecate qua field `description: "[deprecated, use task_create_v2]"` thay vì xóa ngay
   - Sau N tuần xóa khỏi manifest

5. **Ký tự cho phép:** `A-Z a-z 0-9 _ - .` (theo MCP spec), max 128 char

### Examples

OK:
- `tasks__task_create`
- `linear__issue_search`
- `gh__pr_list`
- `git__status_summary`
- `kubectl__pod_logs`

Không OK (lý do):
- `task_create` (thiếu namespace prefix)
- `tasks_task_create` (sai separator, dùng `_` đơn)
- `tasksCreateTask` (camelCase, không snake_case)
- `linear_v2__issue_search` (encode version trong namespace)
- `task_create_new` (vague, không phải verb_object semantic)

## Why

- **API stability discipline:** treat tool name như public REST endpoint name — không rename thoải mái
- `__` separator vừa bắt mắt, vừa không xung đột với MCP spec, vừa dễ split khi parse
- Versioning trong tên rất tệ ở MCP context vì client cache approval per-name → đổi version = approval reset
- Tách namespace / action giúp profile filter (ADR-002) và conflict detection dễ implement

## Why not others

| Alternative | Rejected because |
|---|---|
| `namespace.action` (dot separator) | Dot có thể bị parse nhầm trong template engine, prompt formatting |
| `namespace:action` (colon) | Không hợp lệ theo MCP spec character set |
| Single flat name (no namespace) | Conflict khi 2 upstream có tool cùng tên |
| Encode version trong namespace | Treat version như channel = versioning hell, mỗi version = full re-config phía client |

## Consequences

- **Good:** Tool name stable → user/agent prompt không vỡ khi gateway evolve
- **Good:** Convention rõ → user mới đọc manifest hiểu ngay namespace gốc của tool
- **Bad:** Cần discipline khi thêm tool — không thoải mái rename
- **Bad:** Khi cần break behavior, phải duy trì 2 tool song song một thời gian → manifest dày hơn tạm thời
- **Risks:**
  - Quên discipline → rename tool đã expose → break user workflow. Mitigation: lint/CI check tool đã có trong git history nhưng đổi tên ở manifest hiện tại = warning

## Revisit when

- MCP spec thêm cơ chế alias / deprecation chính thức → có thể relax discipline
- Có > 100 tool và namespace prefix dài làm UX kém → cân nhắc registered short-alias

## Related

- ADR-001: Architecture overview
- ADR-002: Tag/profile (tag dùng để group, name dùng để identify — không trộn 2 concept)
- ADR-004: sideEffecting (đổi side effect = breaking change semantic, áp dụng rule "tool mới")
