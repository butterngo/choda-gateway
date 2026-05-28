import type { CredentialProvider } from "../auth/types.js";
import type { Tool } from "../manifest/types.js";
import type { UpstreamAdapter } from "../types.js";
import { createCliAdapter } from "./cli-adapter.js";
import { type McpAdapterOptions, createMcpAdapter } from "./mcp-adapter.js";
import { type RestAdapterOptions, createRestAdapter } from "./rest-adapter.js";

export type {
	AdapterContext,
	AdapterLogger,
	NormalizedContentItem,
	NormalizedToolCall,
	NormalizedToolResult,
	RetryPolicy,
	ToolPolicy,
	UpstreamAdapter,
	UpstreamType,
} from "../types.js";

export interface CreateAdapterOptions {
	mcp?: McpAdapterOptions;
	rest?: RestAdapterOptions;
	/**
	 * Registry keyed by `tool.authProfile`. When `tool.authProfile` resolves to
	 * a provider here, the REST adapter awaits it per call and merges the
	 * resulting headers + query into the outbound request. Tools without
	 * `authProfile` behave exactly as before.
	 */
	credentialProviders?: ReadonlyMap<string, CredentialProvider>;
}

/**
 * Dispatch a tool definition to the correct adapter factory.
 * Used by the router to materialise one adapter instance per tool.
 */
export function createAdapter(
	tool: Tool,
	opts: CreateAdapterOptions = {},
): UpstreamAdapter {
	switch (tool.upstream.type) {
		case "mcp":
			return createMcpAdapter(tool, opts.mcp);
		case "rest": {
			const provider = tool.authProfile
				? opts.credentialProviders?.get(tool.authProfile)
				: undefined;
			return createRestAdapter(tool, {
				...opts.rest,
				credentialProvider: provider,
			});
		}
		case "cli":
			return createCliAdapter(tool);
	}
}

export interface Semaphore {
	acquire(): Promise<() => void>;
}

export function createSemaphore(max: number): Semaphore {
	if (!Number.isInteger(max) || max < 1) {
		throw new Error(`semaphore size must be a positive integer, got ${max}`);
	}
	let inflight = 0;
	const waiters: Array<() => void> = [];
	return {
		acquire(): Promise<() => void> {
			return new Promise((resolve) => {
				const tryGrant = () => {
					if (inflight < max) {
						inflight++;
						resolve(() => {
							inflight--;
							const next = waiters.shift();
							if (next) next();
						});
					} else {
						waiters.push(tryGrant);
					}
				};
				tryGrant();
			});
		},
	};
}

export async function withSlot<T>(
	sem: Semaphore,
	fn: () => Promise<T>,
): Promise<T> {
	const release = await sem.acquire();
	try {
		return await fn();
	} finally {
		release();
	}
}

export class AdapterTimeoutError extends Error {
	constructor(public readonly timeoutMs: number) {
		super(`adapter call timed out after ${timeoutMs}ms`);
		this.name = "AdapterTimeoutError";
	}
}

export function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	onTimeout?: () => void,
): Promise<T> {
	if (timeoutMs <= 0) return promise;
	return new Promise<T>((resolve, reject) => {
		const handle = setTimeout(() => {
			onTimeout?.();
			reject(new AdapterTimeoutError(timeoutMs));
		}, timeoutMs);
		promise.then(
			(v) => {
				clearTimeout(handle);
				resolve(v);
			},
			(err) => {
				clearTimeout(handle);
				reject(err);
			},
		);
	});
}
