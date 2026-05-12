import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { AuditLogger } from "./audit/logger.js";
import type { AuditEntry } from "./audit/types.js";
import { buildMcpServer } from "./index.js";
import type { Tool } from "./manifest/types.js";
import { createRouter } from "./router.js";
import type { SecretStore } from "./secrets/store.js";
import type {
	AdapterContext,
	NormalizedToolResult,
	UpstreamAdapter,
} from "./types.js";

function emptySecretStore(): SecretStore {
	return {
		async get(name) {
			throw new Error(`secret missing: ${name}`);
		},
		async has() {
			return false;
		},
		async list() {
			return [];
		},
		maskValue() {
			return false;
		},
		maskedValues() {
			return [];
		},
	};
}

function makeAuditLogger(): AuditLogger & { entries: AuditEntry[] } {
	const entries: AuditEntry[] = [];
	return {
		entries,
		async log(entry) {
			entries.push(entry);
		},
	};
}

function makeAdapter(
	type: "mcp" | "rest" | "cli",
	result: NormalizedToolResult,
): UpstreamAdapter {
	return {
		type,
		async init(_ctx: AdapterContext) {},
		async call() {
			return result;
		},
		async dispose() {},
	};
}

const TOOL_MCP: Tool = {
	name: "tasks__list",
	description: "list tasks (mock mcp)",
	inputSchema: { type: "object" },
	tags: ["coding"],
	upstream: {
		type: "mcp",
		command: "node",
		args: ["mock.js"],
		remoteTool: "task_list",
	},
	concurrency: 4,
	timeoutMs: 5000,
	retryPolicy: "none",
	sideEffecting: false,
} as Tool;

const TOOL_REST: Tool = {
	name: "linear__search",
	description: "search Linear (mock rest)",
	inputSchema: {
		type: "object",
		required: ["q"],
		properties: { q: { type: "string" } },
	},
	tags: ["coding"],
	upstream: {
		type: "rest",
		method: "POST",
		url: "https://api.linear.app/graphql",
		bodyTemplate: { q: "{{input.q}}" },
	},
	concurrency: 8,
	timeoutMs: 5000,
	retryPolicy: "safe-idempotent",
	sideEffecting: false,
} as Tool;

const TOOL_CLI: Tool = {
	name: "git__status",
	description: "git status (mock cli)",
	inputSchema: { type: "object" },
	tags: ["coding"],
	upstream: { type: "cli", command: "git", args: ["status"] },
	concurrency: 1,
	timeoutMs: 5000,
	retryPolicy: "none",
	sideEffecting: false,
} as Tool;

describe("MCP server entry — 3 example tools end-to-end via InMemoryTransport", () => {
	it("tools/list returns all 3 tools through the wire", async () => {
		const audit = makeAuditLogger();
		const router = await createRouter({
			tools: [TOOL_MCP, TOOL_REST, TOOL_CLI],
			secretStore: emptySecretStore(),
			auditLogger: audit,
			profile: "coding",
			adapterFactory: (tool) =>
				makeAdapter(tool.upstream.type as "mcp" | "rest" | "cli", {
					content: [{ type: "text", text: `from-${tool.name}` }],
				}),
		});
		const server = buildMcpServer({ router });
		const [serverTransport, clientTransport] =
			InMemoryTransport.createLinkedPair();

		await server.connect(serverTransport);
		const client = new Client(
			{ name: "test", version: "0.0.0" },
			{ capabilities: {} },
		);
		await client.connect(clientTransport);

		const list = await client.listTools();
		expect(list.tools.map((t) => t.name).sort()).toEqual(
			["git__status", "linear__search", "tasks__list"].sort(),
		);

		await client.close();
		await router.dispose();
	});

	it("tools/call dispatches mcp + rest + cli to their adapters and returns content", async () => {
		const audit = makeAuditLogger();
		const router = await createRouter({
			tools: [TOOL_MCP, TOOL_REST, TOOL_CLI],
			secretStore: emptySecretStore(),
			auditLogger: audit,
			profile: "coding",
			adapterFactory: (tool) =>
				makeAdapter(tool.upstream.type as "mcp" | "rest" | "cli", {
					content: [{ type: "text", text: `${tool.name}-ok` }],
					meta: { durationMs: 1 },
				}),
		});
		const server = buildMcpServer({ router });
		const [serverTransport, clientTransport] =
			InMemoryTransport.createLinkedPair();

		await server.connect(serverTransport);
		const client = new Client(
			{ name: "test", version: "0.0.0" },
			{ capabilities: {} },
		);
		await client.connect(clientTransport);

		const mcpResult = await client.callTool({
			name: "tasks__list",
			arguments: {},
		});
		const restResult = await client.callTool({
			name: "linear__search",
			arguments: { q: "go" },
		});
		const cliResult = await client.callTool({
			name: "git__status",
			arguments: {},
		});

		expect(
			(mcpResult.content as Array<{ type: string; text?: string }>)[0],
		).toEqual({ type: "text", text: "tasks__list-ok" });
		expect(
			(restResult.content as Array<{ type: string; text?: string }>)[0],
		).toEqual({ type: "text", text: "linear__search-ok" });
		expect(
			(cliResult.content as Array<{ type: string; text?: string }>)[0],
		).toEqual({ type: "text", text: "git__status-ok" });

		// 3 tools × 4 audit events each = 12 entries.
		expect(audit.entries).toHaveLength(12);

		await client.close();
		await router.dispose();
	});

	it("returns isError content when input fails schema validation", async () => {
		const audit = makeAuditLogger();
		const router = await createRouter({
			tools: [TOOL_REST],
			secretStore: emptySecretStore(),
			auditLogger: audit,
			profile: "coding",
			adapterFactory: () =>
				makeAdapter("rest", {
					content: [{ type: "text", text: "should-not-reach" }],
				}),
		});
		const server = buildMcpServer({ router });
		const [serverTransport, clientTransport] =
			InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		const client = new Client(
			{ name: "test", version: "0.0.0" },
			{ capabilities: {} },
		);
		await client.connect(clientTransport);
		const r = await client.callTool({
			name: "linear__search",
			arguments: {} as Record<string, unknown>,
		});
		expect(r.isError).toBe(true);
		const c = (r.content as Array<{ type: string; text?: string }>)[0];
		expect(c.type).toBe("text");
		expect(String(c.text)).toContain("invalid input");
		await client.close();
		await router.dispose();
	});

	it("returns isError content when calling an unknown tool", async () => {
		const router = await createRouter({
			tools: [TOOL_REST],
			secretStore: emptySecretStore(),
			auditLogger: makeAuditLogger(),
			profile: "coding",
			adapterFactory: () =>
				makeAdapter("rest", { content: [{ type: "text", text: "" }] }),
		});
		const server = buildMcpServer({ router });
		const [serverTransport, clientTransport] =
			InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		const client = new Client(
			{ name: "test", version: "0.0.0" },
			{ capabilities: {} },
		);
		await client.connect(clientTransport);
		const r = await client.callTool({
			name: "ghost__tool",
			arguments: {},
		});
		expect(r.isError).toBe(true);
		const c = (r.content as Array<{ type: string; text?: string }>)[0];
		expect(String(c.text)).toContain("unknown tool");
		await client.close();
		await router.dispose();
	});
});
