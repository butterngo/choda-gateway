import { type Server, createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Tool } from "../manifest/types.js";
import type { AdapterContext, NormalizedToolCall } from "../types.js";
import { createAdapter } from "./upstream-adapter.js";

const MOCK_MCP_CHILD = resolve(
	fileURLToPath(import.meta.url),
	"..",
	"..",
	"..",
	"tests",
	"fixtures",
	"mock-mcp-child.mjs",
);

const NOOP_LOGGER = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

function makeCtx(secrets: Record<string, string> = {}): AdapterContext {
	return { upstreamName: "integration", secrets, logger: NOOP_LOGGER };
}

function makeCall(
	tool: Tool,
	input: Record<string, unknown>,
): NormalizedToolCall {
	return {
		toolName: tool.name,
		input,
		secretRefs: [],
		policy: {
			concurrency: tool.concurrency,
			timeoutMs: tool.timeoutMs,
			retryPolicy: tool.retryPolicy,
			sideEffecting: tool.sideEffecting,
		},
		correlationId: "corr_integration_001",
	};
}

let restServer: Server | undefined;

afterEach(async () => {
	if (restServer) {
		await new Promise<void>((resolve) => restServer?.close(() => resolve()));
		restServer = undefined;
	}
});

describe("adapters integration — one tool per upstream type", () => {
	it("dispatches mcp, rest, cli tools through createAdapter() and returns results", async () => {
		// Start a tiny REST server returning {ok:true} for the rest tool.
		const port = await new Promise<number>((resolve) => {
			restServer = createServer((_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end('{"ok":true}');
			});
			restServer.listen(0, "127.0.0.1", () => {
				const addr = restServer?.address();
				if (!addr || typeof addr === "string") throw new Error("no port bound");
				resolve(addr.port);
			});
		});

		const mcpTool: Tool = {
			name: "tasks__task_create",
			description: "create a task (mock)",
			inputSchema: { type: "object" },
			tags: ["coding"],
			upstream: {
				type: "mcp",
				command: process.execPath,
				args: [MOCK_MCP_CHILD],
				remoteTool: "__echo",
			},
			concurrency: 4,
			timeoutMs: 5000,
			retryPolicy: "none",
			sideEffecting: true,
		};

		const restTool: Tool = {
			name: "linear__issue_search",
			description: "search Linear (mock)",
			inputSchema: { type: "object" },
			tags: ["coding"],
			upstream: {
				type: "rest",
				method: "POST",
				url: `http://127.0.0.1:${port}/graphql`,
				headers: { authorization: "Bearer {{secrets.LINEAR_API_KEY}}" },
				bodyTemplate: { query: "{{input.query}}" },
			},
			concurrency: 8,
			timeoutMs: 5000,
			retryPolicy: "safe-idempotent",
			sideEffecting: false,
		};

		const cliTool: Tool = {
			name: "git__status_summary",
			description: "git status (mock via node)",
			inputSchema: { type: "object" },
			tags: ["coding"],
			upstream: {
				type: "cli",
				command: process.execPath,
				args: ["-e", "console.log('M  src/foo.ts')"],
			},
			concurrency: 1,
			timeoutMs: 5000,
			retryPolicy: "none",
			sideEffecting: false,
		};

		const mcpAdapter = createAdapter(mcpTool);
		const restAdapter = createAdapter(restTool, {
			rest: { backoffSchedule: [0], sleep: async () => {} },
		});
		const cliAdapter = createAdapter(cliTool);

		await mcpAdapter.init(makeCtx());
		await restAdapter.init(makeCtx({ LINEAR_API_KEY: "test-key-123" }));
		await cliAdapter.init(makeCtx());

		const [mcpResult, restResult, cliResult] = await Promise.all([
			mcpAdapter.call(makeCall(mcpTool, { message: "from-integration" })),
			restAdapter.call(makeCall(restTool, { query: "open prs" })),
			cliAdapter.call(makeCall(cliTool, {})),
		]);

		expect(mcpResult.content[0]).toEqual({
			type: "text",
			text: "echo: from-integration",
		});
		expect(mcpResult.isError).toBeUndefined();

		expect(restResult.meta?.httpStatus).toBe(200);
		expect(restResult.content[0]).toEqual({
			type: "text",
			text: '{"ok":true}',
		});

		expect(cliResult.content[0]).toEqual({
			type: "text",
			text: "M  src/foo.ts\n",
		});
		expect(cliResult.isError).toBeUndefined();

		await mcpAdapter.dispose();
		await restAdapter.dispose();
		await cliAdapter.dispose();
	});
});
