import { type IncomingMessage, type Server, createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool } from "../manifest/types.js";
import type { AdapterContext, NormalizedToolCall } from "../types.js";
import { createRestAdapter } from "./rest-adapter.js";
import { AdapterTimeoutError } from "./upstream-adapter.js";

const NOOP_LOGGER = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

function makeTool(overrides: Partial<Tool> = {}): Tool {
	return {
		name: "linear__issue_search",
		description: "search Linear issues",
		inputSchema: { type: "object" },
		tags: ["coding"],
		upstream: {
			type: "rest",
			method: "POST",
			url: "http://127.0.0.1:0/echo",
			headers: { authorization: "Bearer {{secrets.LINEAR_API_KEY}}" },
			bodyTemplate: { query: "{{input.query}}" },
		},
		concurrency: 4,
		timeoutMs: 1000,
		retryPolicy: "safe-idempotent",
		sideEffecting: false,
		...overrides,
	} as Tool;
}

function makeCtx(secrets: Record<string, string> = {}): AdapterContext {
	return {
		upstreamName: "linear-rest",
		secrets,
		logger: NOOP_LOGGER,
	};
}

function makeCall(
	overrides: Partial<NormalizedToolCall> = {},
): NormalizedToolCall {
	return {
		toolName: "linear__issue_search",
		input: { query: "abc" },
		secretRefs: ["LINEAR_API_KEY"],
		policy: {
			concurrency: 4,
			timeoutMs: 1000,
			retryPolicy: "safe-idempotent",
			sideEffecting: false,
		},
		correlationId: "corr_rest_001",
		...overrides,
	};
}

interface ServerHandle {
	server: Server;
	port: number;
	requests: Array<{
		method: string;
		url: string;
		headers: NodeJS.Dict<string | string[]>;
		body: string;
	}>;
}

function startServer(
	handler: (
		req: IncomingMessage,
		body: string,
		callNumber: number,
	) => { status: number; body: string; headers?: Record<string, string> },
): Promise<ServerHandle> {
	return new Promise((resolve) => {
		const requests: ServerHandle["requests"] = [];
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf8");
				requests.push({
					method: req.method ?? "",
					url: req.url ?? "",
					headers: req.headers,
					body,
				});
				const out = handler(req, body, requests.length);
				const headers = out.headers ?? {};
				res.writeHead(out.status, headers);
				res.end(out.body);
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				throw new Error("server address not bound");
			}
			resolve({ server, port: addr.port, requests });
		});
	});
}

function stopServer(h: ServerHandle): Promise<void> {
	return new Promise((resolve) => h.server.close(() => resolve()));
}

let handle: ServerHandle;
const noBackoff = { backoffSchedule: [0, 0], sleep: async () => {} };

afterEach(async () => {
	if (handle) await stopServer(handle);
});

describe("rest-adapter", () => {
	it("injects secret into Authorization header and resolves body template", async () => {
		handle = await startServer(() => ({
			status: 200,
			body: '{"ok":true}',
			headers: { "x-request-id": "req-abc" },
		}));
		const adapter = createRestAdapter(
			makeTool({
				upstream: {
					type: "rest",
					method: "POST",
					url: `http://127.0.0.1:${handle.port}/q`,
					headers: { authorization: "Bearer {{secrets.LINEAR_API_KEY}}" },
					bodyTemplate: { query: "{{input.query}}" },
				},
			}),
		);
		await adapter.init(makeCtx({ LINEAR_API_KEY: "tok_sekret" }));
		const r = await adapter.call(makeCall({ input: { query: "ship it" } }));

		expect(handle.requests).toHaveLength(1);
		const req = handle.requests[0];
		expect(req.method).toBe("POST");
		expect(req.url).toBe("/q");
		expect(req.headers.authorization).toBe("Bearer tok_sekret");
		expect(req.headers["content-type"]).toMatch(/application\/json/);
		expect(JSON.parse(req.body)).toEqual({ query: "ship it" });

		expect(r.meta?.httpStatus).toBe(200);
		expect(r.meta?.upstreamRequestId).toBe("req-abc");
		expect(r.content[0]).toEqual({ type: "text", text: '{"ok":true}' });
		await adapter.dispose();
	});

	it("retries on 5xx for safe-idempotent up to attempts budget then returns last", async () => {
		handle = await startServer((_req, _body, n) => {
			if (n < 3) return { status: 502, body: "bad gateway" };
			return { status: 200, body: '{"ok":true}' };
		});
		const adapter = createRestAdapter(
			makeTool({
				upstream: {
					type: "rest",
					method: "GET",
					url: `http://127.0.0.1:${handle.port}/x`,
				},
			}),
			noBackoff,
		);
		await adapter.init(makeCtx());
		const r = await adapter.call(makeCall());
		expect(handle.requests).toHaveLength(3);
		expect(r.meta?.httpStatus).toBe(200);
		await adapter.dispose();
	});

	it("does NOT retry when policy=none", async () => {
		handle = await startServer(() => ({
			status: 500,
			body: "err",
		}));
		const adapter = createRestAdapter(
			makeTool({
				retryPolicy: "none",
				upstream: {
					type: "rest",
					method: "GET",
					url: `http://127.0.0.1:${handle.port}/x`,
				},
			}),
			noBackoff,
		);
		await adapter.init(makeCtx());
		const r = await adapter.call(
			makeCall({
				policy: { ...makeCall().policy, retryPolicy: "none" },
			}),
		);
		expect(handle.requests).toHaveLength(1);
		expect(r.isError).toBe(true);
		expect(r.meta?.httpStatus).toBe(500);
		await adapter.dispose();
	});

	it("returns isError on final 5xx after exhausting retries", async () => {
		handle = await startServer(() => ({ status: 502, body: "still bad" }));
		const adapter = createRestAdapter(
			makeTool({
				upstream: {
					type: "rest",
					method: "GET",
					url: `http://127.0.0.1:${handle.port}/x`,
				},
			}),
			noBackoff,
		);
		await adapter.init(makeCtx());
		const r = await adapter.call(makeCall());
		// backoffSchedule.length=2 → max 3 attempts
		expect(handle.requests).toHaveLength(3);
		expect(r.isError).toBe(true);
		expect(r.meta?.httpStatus).toBe(502);
		await adapter.dispose();
	});

	it("times out long-running request", async () => {
		// Server delays response 500ms; timeout 100ms.
		handle = await startServer((_req, _body) => ({ status: 200, body: "ok" }));
		// Patch handler to delay before responding:
		handle.server.removeAllListeners("request");
		handle.server.on("request", (_req, res) => {
			setTimeout(() => {
				res.writeHead(200);
				res.end("ok");
			}, 500);
		});
		const adapter = createRestAdapter(
			makeTool({
				timeoutMs: 100,
				retryPolicy: "none",
				upstream: {
					type: "rest",
					method: "GET",
					url: `http://127.0.0.1:${handle.port}/x`,
				},
			}),
			noBackoff,
		);
		await adapter.init(makeCtx());
		await expect(
			adapter.call(
				makeCall({
					policy: {
						...makeCall().policy,
						timeoutMs: 100,
						retryPolicy: "none",
					},
				}),
			),
		).rejects.toBeInstanceOf(AdapterTimeoutError);
		await adapter.dispose();
	});

	it("rejects construction of non-rest tool", () => {
		expect(() =>
			createRestAdapter(
				makeTool({
					upstream: {
						type: "cli",
						command: "ls",
					} as Tool["upstream"],
				}),
			),
		).toThrow(/rest/);
	});
});
