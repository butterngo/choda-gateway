import { fetch } from "undici";
import { AuthResolveError, type CredentialProvider } from "../auth/types.js";
import type { Tool } from "../manifest/types.js";
import type {
	AdapterContext,
	NormalizedToolCall,
	NormalizedToolResult,
	UpstreamAdapter,
} from "../types.js";
import { resolveTemplate } from "../util/template.js";
import {
	AdapterTimeoutError,
	type Semaphore,
	createSemaphore,
	withSlot,
} from "./upstream-adapter.js";

interface RestUpstream {
	type: "rest";
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	url: string;
	headers?: Record<string, string>;
	bodyTemplate?: unknown;
}

function assertRest(
	tool: Tool,
): asserts tool is Tool & { upstream: RestUpstream } {
	if (tool.upstream.type !== "rest") {
		throw new Error(
			`createRestAdapter requires a rest tool, got '${tool.upstream.type}'`,
		);
	}
}

export interface RestAdapterOptions {
	/**
	 * Backoff schedule (ms) used between retry attempts when
	 * `retryPolicy === "safe-idempotent"` and the error is transient.
	 * The number of retries equals `backoffSchedule.length`; total attempts
	 * is `length + 1` (initial + retries). Default `[200, 500]` → 3 attempts.
	 */
	backoffSchedule?: number[];
	/**
	 * Override the global fetch (for tests).
	 */
	fetchImpl?: typeof fetch;
	/**
	 * Sleep function (for tests) — replaces `setTimeout`-based delay.
	 */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * Resolved per `tool.authProfile`. When present, `resolve()` is awaited
	 * before each outbound request and the resulting headers + query are
	 * merged in. Provider failure → `AuthResolveError` (no fall-through to
	 * an unauthenticated request).
	 */
	credentialProvider?: CredentialProvider;
}

const DEFAULT_BACKOFF = [200, 500];

export function createRestAdapter(
	tool: Tool,
	opts: RestAdapterOptions = {},
): UpstreamAdapter {
	assertRest(tool);
	const upstream = tool.upstream;
	const sem: Semaphore = createSemaphore(tool.concurrency);
	const fetchImpl = opts.fetchImpl ?? fetch;
	const sleep = opts.sleep ?? defaultSleep;
	const backoff = opts.backoffSchedule ?? DEFAULT_BACKOFF;
	const credentialProvider = opts.credentialProvider;
	let ctx: AdapterContext | null = null;

	return {
		type: "rest",
		async init(context) {
			ctx = context;
		},
		async call(normalized) {
			const localCtx = ctx;
			if (!localCtx) throw new Error("rest adapter not initialized");
			return withSlot(sem, () =>
				executeWithRetry(
					tool,
					upstream,
					localCtx,
					normalized,
					fetchImpl,
					sleep,
					backoff,
					credentialProvider,
				),
			);
		},
		async dispose() {
			// undici fetch reuses a global agent pool; nothing to release per-adapter.
		},
	};
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeWithRetry(
	tool: Tool,
	upstream: RestUpstream,
	ctx: AdapterContext,
	call: NormalizedToolCall,
	fetchImpl: typeof fetch,
	sleep: (ms: number) => Promise<void>,
	backoff: number[],
	credentialProvider: CredentialProvider | undefined,
): Promise<NormalizedToolResult> {
	const maxAttempts =
		call.policy.retryPolicy === "safe-idempotent" ? backoff.length + 1 : 1;
	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const result = await executeOnce(
				upstream,
				ctx,
				call,
				fetchImpl,
				attempt,
				credentialProvider,
				tool,
			);
			// Retry on 5xx for safe-idempotent (within attempt budget).
			if (
				result.meta?.httpStatus !== undefined &&
				result.meta.httpStatus >= 500 &&
				attempt < maxAttempts
			) {
				ctx.logger.warn("rest 5xx, retrying", {
					toolName: call.toolName,
					correlationId: call.correlationId,
					attempt,
					status: result.meta.httpStatus,
				});
				await sleep(backoff[attempt - 1]);
				continue;
			}
			return result;
		} catch (err) {
			lastErr = err;
			if (err instanceof AdapterTimeoutError) throw err;
			if (attempt >= maxAttempts) break;
			ctx.logger.warn("rest transient error, retrying", {
				toolName: call.toolName,
				correlationId: call.correlationId,
				attempt,
				error: String(err),
			});
			await sleep(backoff[attempt - 1]);
		}
	}
	throw lastErr instanceof Error
		? lastErr
		: new Error(`rest call failed: ${String(lastErr)}`);
}

async function executeOnce(
	upstream: RestUpstream,
	ctx: AdapterContext,
	call: NormalizedToolCall,
	fetchImpl: typeof fetch,
	attempt: number,
	credentialProvider: CredentialProvider | undefined,
	tool: Tool,
): Promise<NormalizedToolResult> {
	const tplCtx = { input: call.input, secrets: ctx.secrets };
	let url = resolveTemplate(upstream.url, tplCtx);
	const headers = resolveTemplate(upstream.headers ?? {}, tplCtx);
	const bodyValue =
		upstream.bodyTemplate === undefined
			? undefined
			: resolveTemplate(upstream.bodyTemplate, tplCtx);
	const body =
		bodyValue === undefined
			? undefined
			: typeof bodyValue === "string"
				? bodyValue
				: JSON.stringify(bodyValue);
	const isJsonBody = body !== undefined && typeof bodyValue !== "string";
	const finalHeaders: Record<string, string> = { ...headers };
	if (isJsonBody && !hasHeader(finalHeaders, "content-type")) {
		finalHeaders["content-type"] = "application/json";
	}

	if (credentialProvider) {
		let resolved: Awaited<ReturnType<typeof credentialProvider.resolve>>;
		try {
			resolved = await credentialProvider.resolve({
				toolName: call.toolName,
				correlationId: call.correlationId,
			});
		} catch (cause) {
			if (cause instanceof AuthResolveError) throw cause;
			throw new AuthResolveError(
				`auth provider failed for tool '${call.toolName}'`,
				tool.authProfile ?? "<unknown>",
				cause,
			);
		}
		for (const [k, v] of Object.entries(resolved.headers)) {
			finalHeaders[k] = v;
		}
		if (resolved.query) {
			url = appendQuery(url, resolved.query);
		}
	}

	const controller = new AbortController();
	const timeoutMs = call.policy.timeoutMs;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	const t0 = performance.now();
	let response: Awaited<ReturnType<typeof fetch>>;
	try {
		response = await fetchImpl(url, {
			method: upstream.method,
			headers: finalHeaders,
			body,
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		if (timedOut) throw new AdapterTimeoutError(timeoutMs);
		ctx.logger.debug("rest fetch error", {
			toolName: call.toolName,
			correlationId: call.correlationId,
			attempt,
			error: String(err),
		});
		throw err;
	}
	clearTimeout(timer);

	const text = await response.text();
	const durationMs = Math.round(performance.now() - t0);
	const httpStatus = response.status;
	const ok = response.ok;
	const result: NormalizedToolResult = {
		content: [{ type: "text", text }],
		meta: {
			durationMs,
			httpStatus,
			upstreamRequestId: response.headers.get("x-request-id") ?? undefined,
		},
	};
	if (!ok) result.isError = true;
	return result;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const lower = name.toLowerCase();
	return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function appendQuery(url: string, query: Record<string, string>): string {
	const u = new URL(url);
	for (const [k, v] of Object.entries(query)) {
		u.searchParams.set(k, v);
	}
	return u.toString();
}
