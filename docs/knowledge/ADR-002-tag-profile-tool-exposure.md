---
type: decision
title: "ADR-002: Tag/profile mechanism for tool exposure — giải bài 128 tool limit của Copilot"
projectId: choda-deck
workspaceId: choda-gateway
scope: project
refs: []
createdAt: 2026-05-10
lastVerifiedAt: 2026-05-10
---

## Context

Copilot Chat (VS Code) có giới hạn cứng **128 enabled tools per request** (đã verify qua docs MCP integration). Khi manifest gateway grow tới ~50-100 tool, vấn đề:

- Copilot vượt 128 = client tự manual disable, không scale được
- Context window bloat: 100 tool × ~300 tokens schema ≈ 30K tokens chỉ cho `tools/list`
- Agent confused: tỷ lệ chọn sai tool tăng khi list dài
- Slow startup khi `tools/list` trả too large

Manifest scope đầy đủ cũng có thể chứa tool đa dạng mà không phải lúc nào cũng cần (vd `linear__*`, `gh__*` chỉ relevant khi coding; `kubectl__*` chỉ khi ops).

## Options considered

| Option | Mô tả | Pro | Con |
|---|---|---|---|
| A. Expose hết, để client tự enable/disable | Status quo nếu không làm gì | Đơn giản code | User phải maintain enabled list ở mỗi client |
| B. Per-client filtering | Gateway nhận diện client (Claude vs Copilot) và filter | Tự động | MCP protocol không có client identification standard |
| **C. Tag + Profile (chosen)** | Tool có `tags[]`; gateway start với `--profile=NAME`; chỉ tool match tag được expose | Đơn giản, multi-instance trong `mcp.json` | User chịu trách nhiệm tag taxonomy |
| D. Dynamic tool selection | Meta-tool `gateway__list_groups` + `gateway__enable_group` | Linh hoạt | Phức tạp; client phải biết workflow 2 bước |

## Decision

**Chọn Option C — Tag + Profile mechanism.**

Spec cụ thể:

- Mỗi tool trong `tools.json` có field `tags: string[]` (≥ 1 tag, lowercase, alphanumeric + dash, max 64 char)
- `gateway.config.yaml` định nghĩa profiles:
  ```yaml
  profiles:
    coding: [coding, planning]
    ops:    [ops, infra]
    all:    [coding, planning, ops, infra]
  ```
- Active profile chọn qua **CLI flag** `--profile=<name>` hoặc **env var** `GATEWAY_PROFILE=<name>`. CLI flag thắng env.
- Tool exposure rule: `intersection(tool.tags, activeProfileTags).length >= 1` thì tool xuất hiện trong `tools/list`
- Profile không tồn tại → fail fast khi startup
- Không có active profile → fail fast (bắt buộc explicit)

**Multi-instance pattern** (cách user dùng):

Trong `.vscode/mcp.json` của Copilot:
```json
{
  "mcpServers": {
    "gateway-coding": { "command": "choda-gateway", "args": ["--profile=coding"] },
    "gateway-ops":    { "command": "choda-gateway", "args": ["--profile=ops"] }
  }
}
```

Mỗi entry là 1 instance gateway riêng (cùng binary, khác profile), share chung manifest + secret store + audit log.

### Why

- Đơn giản nhất trong các option: 1 field `tags`, 1 flag, 1 lookup table
- Multi-instance pattern lợi dụng chính cơ chế MCP server config sẵn của client — không cần feature mới phía client
- Không cần MCP client identification (vốn không có standard)
- Tag taxonomy là cost VuNgo phải trả nhưng cũng là benefit — buộc nghĩ về tool grouping rõ ràng

## Why not others

| Option | Rejected because |
|---|---|
| A. Expose hết | Không giải bài 128 limit |
| B. Per-client filter | MCP protocol không có client identification; hack qua user-agent/process name là fragile |
| D. Dynamic selection | Phức tạp UX, agent phải hiểu meta-tool — defer cho Phase 3 nếu cần |

## Consequences

- **Good:** Mỗi instance gateway exposes < 30 tool, không đụng trần 128, context window gọn, agent ít confused
- **Good:** Tag là metadata light-weight, dễ thêm/sửa
- **Bad:** User phải maintain tag taxonomy + profile config — cần document pattern
- **Bad:** Switch context = restart gateway instance (acceptable do client đã quản lý lifecycle MCP server)
- **Risks:**
  - Profile granularity sai → user phải thiết kế lại profiles. Mitigation: bắt đầu với 2-3 profile thô, refine theo thực tế
  - Tag drift (typo, duplicate semantic) → manifest validate có thể warn về tag chưa khai báo trong profile bất kỳ

## Revisit when

- User cần switch profile mà không restart → cân nhắc hot profile reload (vẫn phải reset cached tools phía client)
- Số tool > 200 và profile granularity không đủ → cân nhắc nested tag / hierarchy
- User muốn enable/disable tool runtime mà không sửa manifest → mở dynamic selection (Option D)

## Related

- ADR-001: Architecture overview
- Copilot Chat MCP docs (128 tool limit)
- File spec: `tools.json` schema v1 (artifact trong CONV-1778389705280-1)
