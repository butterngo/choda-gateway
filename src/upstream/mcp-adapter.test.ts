import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Tool } from "../manifest/types.js";
import type { AdapterContext, NormalizedToolCall } from "../types.js";
import { McpUpstreamClosedError, createMcpAdapter } from "./mcp-adapter.js";
import { AdapterTimeoutError } from "./upstream-adapter.js";

const MOCK_CHILD = resolve(
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

function makeTool(overrides: Partial<Tool> = {}): Tool {
	return {
		name: "tasks__task_create",
		description: "create a task",
		inputSchema: { type: "object" },
		tags: ["coding"],
		upstream: {
			type: "mcp",
			command: process.execPath,
			args: [MOCK_CHILD],
			remoteTool: "__echo",
		},
		concurrency: 4,
		timeoutMs: 5000,
		retryPolicy: "none",
		sideEffecting: true,
		...overrides,
	} as Tool;
}

function makeCtx(): AdapterContext {
	return {
		upstreamName: "mock-mcp",
		secrets: {},
		logger: NOOP_LOGGER,
	};
}

function makeCall(
	overrides: Partial<NormalizedToolCall> = {},
): NormalizedToolCall {
	return {
		toolName: "tasks__task_create",
		input: {},
		secretRefs: [],
		policy: {
			concurrency: 4,
			timeoutMs: 5000,
			retryPolicy: "none",
			sideEffecting: true,
		},
		correlationId: "corr_mcp_001",
		...overrides,
	};
}

describe("mcp-adapter", () => {
	it("handshake + call returns text + structuredContent", async () => {
		const adapter = createMcpAdapter(makeTool());
		await adapter.init(makeCtx());
		const r = await adapter.call(makeCall({ input: { message: "hi" } }));
		expect(r.content).toEqual([{ type: "text", text: "echo: hi" }]);
		expect(r.structuredContent).toEqual({ message: "hi" });
		expect(r.meta?.durationMs).toBeGreaterThanOrEqual(0);
		expect(r.isError).toBeUndefined();
		await adapter.dispose();
	});

	it("supports out-of-order responses (concurrent calls)", async () => {
		const adapter = createMcpAdapter(
			makeTool({
				upstream: {
					type: "mcp",
					command: process.execPath,
					args: [MOCK_CHILD],
					remoteTool: "__slow",
				},
			}),
		);
		await adapter.init(makeCtx());
		// 4 calls — fast one (50ms) issued last should still resolve correctly.
		const t0 = Date.now();
		const [a, b, c, d] = await Promise.all([
			adapter.call(makeCall({ input: { ms: 200 } })),
			adapter.call(makeCall({ input: { ms: 200 } })),
			adapter.call(makeCall({ input: { ms: 200 } })),
			adapter.call(makeCall({ input: { ms: 50 } })),
		]);
		const elapsed = Date.now() - t0;
		// Concurrency 4 → all run in parallel, total ≈ 200ms (not 650ms).
		expect(elapsed).toBeLessThan(400);
		for (const r of [a, b, c, d]) {
			expect(r.content[0]).toEqual({ type: "text", text: "slow-done" });
		}
		await adapter.dispose();
	});

	it("passes isError flag through from upstream", async () => {
		const adapter = createMcpAdapter(
			makeTool({
				upstream: {
					type: "mcp",
					command: process.execPath,
					args: [MOCK_CHILD],
					remoteTool: "__fail",
				},
			}),
		);
		await adapter.init(makeCtx());
		const r = await adapter.call(makeCall());
		expect(r.isError).toBe(true);
		expect(r.content[0]).toEqual({ type: "text", text: "intentional fail" });
		await adapter.dispose();
	});

	it("times out slow upstream tool", async () => {
		const adapter = createMcpAdapter(
			makeTool({
				upstream: {
					type: "mcp",
					command: process.execPath,
					args: [MOCK_CHILD],
					remoteTool: "__slow",
				},
				timeoutMs: 100,
			}),
		);
		await adapter.init(makeCtx());
		await expect(
			adapter.call(
				makeCall({
					input: { ms: 2000 },
					policy: { ...makeCall().policy, timeoutMs: 100 },
				}),
			),
		).rejects.toBeInstanceOf(AdapterTimeoutError);
		await adapter.dispose();
	});

	it("surfaces upstream crash on subsequent call as closed error", async () => {
		const adapter = createMcpAdapter(
			makeTool({
				upstream: {
					type: "mcp",
					command: process.execPath,
					args: [MOCK_CHILD],
					remoteTool: "__crash",
				},
			}),
		);
		await adapter.init(makeCtx());
		// First call: response races with exit(101). Either it succeeds (response
		// flushed before exit) or it rejects with a transport-closed error.
		const first = await adapter.call(makeCall()).catch((err) => err);
		expect(
			first?.content?.[0]?.text === "about-to-crash" || first instanceof Error,
		).toBe(true);
		// Give the child a tick to actually exit and the transport to notice.
		await new Promise((resolve) => setTimeout(resolve, 200));
		// Second call must reject because the upstream is now dead.
		await expect(adapter.call(makeCall())).rejects.toThrow();
		await adapter.dispose();
	});

	it("rejects construction of non-mcp tool", () => {
		expect(() =>
			createMcpAdapter(
				makeTool({
					upstream: {
						type: "rest",
						method: "GET",
						url: "x",
					} as Tool["upstream"],
				}),
			),
		).toThrow(/mcp/);
	});

	// Type assertion exercised via the closed error class for coverage parity.
	it("exports McpUpstreamClosedError as a distinct Error", () => {
		const err = new McpUpstreamClosedError("test");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("McpUpstreamClosedError");
	});
});
