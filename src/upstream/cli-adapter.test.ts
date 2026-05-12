import { describe, expect, it } from "vitest";
import type { Tool } from "../manifest/types.js";
import type { AdapterContext, NormalizedToolCall } from "../types.js";
import { createCliAdapter } from "./cli-adapter.js";
import { AdapterTimeoutError } from "./upstream-adapter.js";

const NOOP_LOGGER = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

function makeTool(overrides: Partial<Tool> = {}): Tool {
	return {
		name: "git__status_summary",
		description: "git status summary",
		inputSchema: { type: "object" },
		tags: ["coding"],
		upstream: {
			type: "cli",
			command: process.execPath, // current node binary
			args: ["-e", "console.log('hi')"],
		},
		concurrency: 1,
		timeoutMs: 5000,
		retryPolicy: "none",
		sideEffecting: false,
		...overrides,
	} as Tool;
}

function makeCtx(secrets: Record<string, string> = {}): AdapterContext {
	return {
		upstreamName: "local-shell",
		secrets,
		logger: NOOP_LOGGER,
	};
}

function makeCall(
	overrides: Partial<NormalizedToolCall> = {},
): NormalizedToolCall {
	return {
		toolName: "git__status_summary",
		input: {},
		secretRefs: [],
		policy: {
			concurrency: 1,
			timeoutMs: 5000,
			retryPolicy: "none",
			sideEffecting: false,
		},
		correlationId: "corr_test_001",
		...overrides,
	};
}

describe("cli-adapter", () => {
	it("captures stdout into text content on exit 0", async () => {
		const adapter = createCliAdapter(makeTool());
		await adapter.init(makeCtx());
		const r = await adapter.call(makeCall());
		expect(r.content).toEqual([{ type: "text", text: "hi\n" }]);
		expect(r.isError).toBeUndefined();
		expect(r.meta?.exitCode).toBe(0);
		expect(r.meta?.durationMs).toBeGreaterThanOrEqual(0);
		await adapter.dispose();
	});

	it("marks isError=true on non-zero exit code", async () => {
		const adapter = createCliAdapter(
			makeTool({
				upstream: {
					type: "cli",
					command: process.execPath,
					args: ["-e", "process.stderr.write('boom'); process.exit(7)"],
				},
			}),
		);
		await adapter.init(makeCtx());
		const r = await adapter.call(makeCall());
		expect(r.isError).toBe(true);
		expect(r.meta?.exitCode).toBe(7);
		expect(r.content[0]).toEqual({ type: "text", text: "boom" });
		await adapter.dispose();
	});

	it("times out long-running command and kills child", async () => {
		const adapter = createCliAdapter(
			makeTool({
				timeoutMs: 100,
				upstream: {
					type: "cli",
					command: process.execPath,
					args: ["-e", "setTimeout(()=>{}, 30000)"],
				},
			}),
		);
		await adapter.init(makeCtx());
		await expect(
			adapter.call(
				makeCall({ policy: { ...makeCall().policy, timeoutMs: 100 } }),
			),
		).rejects.toBeInstanceOf(AdapterTimeoutError);
		await adapter.dispose();
	});

	it("resolves {{input.X}} placeholders in args before spawn", async () => {
		const adapter = createCliAdapter(
			makeTool({
				upstream: {
					type: "cli",
					command: process.execPath,
					args: ["-e", "console.log(process.argv[1])", "{{input.label}}"],
				},
			}),
		);
		await adapter.init(makeCtx());
		const r = await adapter.call(makeCall({ input: { label: "alpha-bravo" } }));
		expect(r.content[0]).toEqual({ type: "text", text: "alpha-bravo\n" });
		await adapter.dispose();
	});

	it("resolves {{secrets.X}} placeholders in env from adapter context", async () => {
		const adapter = createCliAdapter(
			makeTool({
				upstream: {
					type: "cli",
					command: process.execPath,
					args: ["-e", "console.log(process.env.MY_TOK || 'none')"],
					env: { MY_TOK: "{{secrets.API_KEY}}" },
				},
			}),
		);
		await adapter.init(makeCtx({ API_KEY: "tok_xyz" }));
		const r = await adapter.call(makeCall({ secretRefs: ["API_KEY"] }));
		expect(r.content[0]).toEqual({ type: "text", text: "tok_xyz\n" });
		await adapter.dispose();
	});

	it("enforces concurrency=1 — second call waits for first", async () => {
		const adapter = createCliAdapter(
			makeTool({
				upstream: {
					type: "cli",
					command: process.execPath,
					args: ["-e", "setTimeout(()=>console.log(Date.now()), 200)"],
				},
			}),
		);
		await adapter.init(makeCtx());
		const t0 = Date.now();
		const [a, b] = await Promise.all([
			adapter.call(makeCall()),
			adapter.call(makeCall()),
		]);
		const elapsed = Date.now() - t0;
		// 2 serial 200ms commands must take >=400ms; if concurrency were >1 it'd be ~200ms.
		expect(elapsed).toBeGreaterThanOrEqual(390);
		const tA = Number(a.content[0].type === "text" ? a.content[0].text : 0);
		const tB = Number(b.content[0].type === "text" ? b.content[0].text : 0);
		expect(Math.abs(tA - tB)).toBeGreaterThanOrEqual(180);
		await adapter.dispose();
	});

	it("rejects construction of non-cli tool", () => {
		expect(() =>
			createCliAdapter(
				makeTool({
					upstream: {
						type: "mcp",
						command: "node",
						remoteTool: "x",
					} as Tool["upstream"],
				}),
			),
		).toThrow(/cli/);
	});

	it("rejects concurrency!=1 even if schema let it through", () => {
		expect(() => createCliAdapter(makeTool({ concurrency: 2 }))).toThrow(
			/concurrency/,
		);
	});

	it("rejects retryPolicy!=none even if schema let it through", () => {
		expect(() =>
			createCliAdapter(makeTool({ retryPolicy: "safe-idempotent" })),
		).toThrow(/retryPolicy/);
	});
});
