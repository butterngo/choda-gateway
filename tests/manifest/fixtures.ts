import type { Tool, ToolsManifest } from "../../src/manifest/types.js";

export function makeMcpTool(overrides: Partial<Tool> = {}): Tool {
	return {
		name: "tasks__task_list",
		description: "List tasks from upstream MCP.",
		inputSchema: { type: "object", properties: {} },
		tags: ["coding", "planning"],
		upstream: {
			type: "mcp",
			command: "node",
			args: ["x.js"],
			remoteTool: "task_list",
		},
		concurrency: 4,
		timeoutMs: 30000,
		retryPolicy: "none",
		sideEffecting: false,
		...overrides,
	};
}

export function makeRestTool(overrides: Partial<Tool> = {}): Tool {
	return {
		name: "linear__issue_search",
		description: "Search Linear issues.",
		inputSchema: { type: "object", properties: {} },
		tags: ["coding", "planning"],
		upstream: { type: "rest", method: "GET", url: "https://api.linear.app" },
		concurrency: 8,
		timeoutMs: 15000,
		retryPolicy: "safe-idempotent",
		sideEffecting: false,
		...overrides,
	};
}

export function makeCliTool(overrides: Partial<Tool> = {}): Tool {
	return {
		name: "gh__pr_list",
		description: "List GitHub PRs.",
		inputSchema: { type: "object", properties: {} },
		tags: ["coding"],
		upstream: { type: "cli", command: "gh", args: ["pr", "list"] },
		concurrency: 1,
		timeoutMs: 30000,
		retryPolicy: "none",
		sideEffecting: false,
		...overrides,
	};
}

export function makeManifest(tools: Tool[]): ToolsManifest {
	return { tools };
}
