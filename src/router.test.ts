import { describe, expect, it, vi } from "vitest";
import type { AuditLogger } from "./audit/logger.js";
import type { AuditEntry } from "./audit/types.js";
import type { Tool } from "./manifest/types.js";
import {
	InputValidationError,
	ToolNotFoundError,
	createRouter,
} from "./router.js";
import type { SecretStore } from "./secrets/store.js";
import type {
	AdapterContext,
	NormalizedToolCall,
	NormalizedToolResult,
	UpstreamAdapter,
} from "./types.js";

function makeTool(overrides: Partial<Tool> = {}): Tool {
	return {
		name: "linear__issue_search",
		description: "search Linear",
		inputSchema: {
			type: "object",
			required: ["query"],
			properties: { query: { type: "string", minLength: 1 } },
		},
		tags: ["coding"],
		upstream: {
			type: "rest",
			method: "POST",
			url: "https://api.linear.app/graphql",
			headers: { authorization: "Bearer {{secrets.LINEAR_API_KEY}}" },
			bodyTemplate: { q: "{{input.query}}" },
		},
		concurrency: 8,
		timeoutMs: 15000,
		retryPolicy: "safe-idempotent",
		sideEffecting: false,
		...overrides,
	} as Tool;
}

function makeSecretStore(values: Record<string, string> = {}): SecretStore {
	const set = new Set(Object.values(values));
	return {
		async get(name) {
			const v = values[name];
			if (v === undefined) throw new Error(`secret missing: ${name}`);
			return v;
		},
		async has(name) {
			return name in values;
		},
		async list() {
			return Object.keys(values);
		},
		maskValue(v) {
			return v.length > 0 && set.has(v);
		},
		maskedValues() {
			return set;
		},
	};
}

interface CapturingAuditLogger extends AuditLogger {
	entries: AuditEntry[];
}

function makeAuditLogger(): CapturingAuditLogger {
	const entries: AuditEntry[] = [];
	return {
		entries,
		async log(entry) {
			entries.push(entry);
		},
	};
}

function makeAdapter(
	result: NormalizedToolResult | Error,
	calls: NormalizedToolCall[] = [],
): UpstreamAdapter {
	return {
		type: "rest",
		async init(_ctx: AdapterContext) {},
		async call(call) {
			calls.push(call);
			if (result instanceof Error) throw result;
			return result;
		},
		async dispose() {},
	};
}

describe("router", () => {
	it("listTools returns the tools it was constructed with", async () => {
		const adapter = makeAdapter({ content: [{ type: "text", text: "x" }] });
		const router = await createRouter({
			tools: [makeTool()],
			secretStore: makeSecretStore(),
			auditLogger: makeAuditLogger(),
			profile: "coding",
			adapterFactory: () => adapter,
		});
		expect(router.listTools()).toEqual([
			{
				name: "linear__issue_search",
				description: "search Linear",
				inputSchema: expect.any(Object),
			},
		]);
		await router.dispose();
	});

	it("rejects unknown tool with ToolNotFoundError", async () => {
		const router = await createRouter({
			tools: [],
			secretStore: makeSecretStore(),
			auditLogger: makeAuditLogger(),
			profile: "coding",
		});
		await expect(router.call("nope__nope", {})).rejects.toBeInstanceOf(
			ToolNotFoundError,
		);
		await router.dispose();
	});

	it("validates input via inputSchema and surfaces InputValidationError", async () => {
		const adapter = makeAdapter({ content: [{ type: "text", text: "x" }] });
		const audit = makeAuditLogger();
		const router = await createRouter({
			tools: [makeTool()],
			secretStore: makeSecretStore({ LINEAR_API_KEY: "k" }),
			auditLogger: audit,
			profile: "coding",
			adapterFactory: () => adapter,
		});
		await expect(
			router.call("linear__issue_search", {} as Record<string, unknown>),
		).rejects.toBeInstanceOf(InputValidationError);
		// audit: request.received + response.returned with errKind=input_validation
		expect(audit.entries.map((e) => e.event)).toEqual([
			"request.received",
			"response.returned",
		]);
		const last = audit.entries[1] as Extract<
			AuditEntry,
			{ event: "response.returned" }
		>;
		expect(last.ok).toBe(false);
		expect(last.errKind).toBe("input_validation");
		await router.dispose();
	});

	it("resolves secrets, calls adapter with NormalizedToolCall, returns result", async () => {
		const captured: NormalizedToolCall[] = [];
		const adapter = makeAdapter(
			{
				content: [{ type: "text", text: "ok" }],
				meta: { durationMs: 5, httpStatus: 200 },
			},
			captured,
		);
		const initSpy = vi.fn(async (_ctx: AdapterContext) => {});
		adapter.init = initSpy;
		const audit = makeAuditLogger();
		const router = await createRouter({
			tools: [makeTool()],
			secretStore: makeSecretStore({ LINEAR_API_KEY: "tok_sekret" }),
			auditLogger: audit,
			profile: "coding",
			adapterFactory: () => adapter,
		});

		const result = await router.call("linear__issue_search", {
			query: "ship it",
		});
		expect(result.content[0]).toEqual({ type: "text", text: "ok" });
		expect(result.isError).toBeUndefined();

		// initSpy was called twice: once at router build, once per-call with resolved secrets.
		expect(initSpy).toHaveBeenCalledTimes(2);
		const lastInitCtx = initSpy.mock.calls[1][0];
		expect(lastInitCtx.secrets).toEqual({ LINEAR_API_KEY: "tok_sekret" });

		// adapter received a NormalizedToolCall with correlationId + policy + secretRefs.
		expect(captured).toHaveLength(1);
		const call = captured[0];
		expect(call.toolName).toBe("linear__issue_search");
		expect(call.input).toEqual({ query: "ship it" });
		expect(call.secretRefs).toEqual(["LINEAR_API_KEY"]);
		expect(call.policy).toEqual({
			concurrency: 8,
			timeoutMs: 15000,
			retryPolicy: "safe-idempotent",
			sideEffecting: false,
		});
		expect(call.correlationId).toMatch(/^corr_/);

		// 4 audit events emitted with shared corrId.
		const corrIds = new Set(audit.entries.map((e) => e.corrId));
		expect(corrIds.size).toBe(1);
		expect(audit.entries.map((e) => e.event)).toEqual([
			"request.received",
			"upstream.dispatched",
			"upstream.completed",
			"response.returned",
		]);
		const dispatched = audit.entries[1] as Extract<
			AuditEntry,
			{ event: "upstream.dispatched" }
		>;
		expect(dispatched.upstreamType).toBe("rest");
		expect(dispatched.upstreamId).toBe("POST https://api.linear.app/graphql");

		await router.dispose();
	});

	it("converts adapter throw → isError result + classifies errKind", async () => {
		class AdapterTimeoutError extends Error {
			constructor() {
				super("timed out");
				this.name = "AdapterTimeoutError";
			}
		}
		const adapter = makeAdapter(new AdapterTimeoutError());
		const audit = makeAuditLogger();
		const router = await createRouter({
			tools: [makeTool()],
			secretStore: makeSecretStore({ LINEAR_API_KEY: "k" }),
			auditLogger: audit,
			profile: "coding",
			adapterFactory: () => adapter,
		});
		const result = await router.call("linear__issue_search", {
			query: "abc",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "timed out" });
		const completed = audit.entries.find(
			(e) => e.event === "upstream.completed",
		) as Extract<AuditEntry, { event: "upstream.completed" }> | undefined;
		expect(completed?.ok).toBe(false);
		expect(completed?.errKind).toBe("timeout");
		await router.dispose();
	});

	it("dispose disposes all adapters", async () => {
		const disposeSpy = vi.fn(async () => {});
		const adapter: UpstreamAdapter = {
			type: "rest",
			async init() {},
			async call() {
				return { content: [{ type: "text", text: "" }] };
			},
			dispose: disposeSpy,
		};
		const router = await createRouter({
			tools: [makeTool(), makeTool({ name: "ops__ping" } as Partial<Tool>)],
			secretStore: makeSecretStore({ LINEAR_API_KEY: "k" }),
			auditLogger: makeAuditLogger(),
			profile: "coding",
			adapterFactory: () => adapter,
		});
		await router.dispose();
		expect(disposeSpy).toHaveBeenCalledTimes(2);
	});

	it("includes upstreamId per upstream type in audit", async () => {
		const cliTool = makeTool({
			name: "git__status",
			tags: ["coding"],
			upstream: {
				type: "cli",
				command: "git",
				args: ["status"],
			} as Tool["upstream"],
			concurrency: 1,
			retryPolicy: "none",
			inputSchema: { type: "object" },
		});
		const mcpTool = makeTool({
			name: "tasks__list",
			tags: ["coding"],
			upstream: {
				type: "mcp",
				command: "node",
				args: ["mcp.js"],
				remoteTool: "task_list",
			} as Tool["upstream"],
			retryPolicy: "none",
			inputSchema: { type: "object" },
		});
		const adapter = makeAdapter({ content: [{ type: "text", text: "" }] });
		const audit = makeAuditLogger();
		const router = await createRouter({
			tools: [cliTool, mcpTool],
			secretStore: makeSecretStore(),
			auditLogger: audit,
			profile: "coding",
			adapterFactory: () => adapter,
		});
		await router.call("git__status", {});
		await router.call("tasks__list", {});
		const dispatched = audit.entries.filter(
			(e) => e.event === "upstream.dispatched",
		) as Array<Extract<AuditEntry, { event: "upstream.dispatched" }>>;
		expect(dispatched[0].upstreamId).toBe("cli:git");
		expect(dispatched[1].upstreamId).toContain("mcp:task_list@");
		await router.dispose();
	});
});
