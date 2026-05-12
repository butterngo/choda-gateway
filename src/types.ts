import type { UpstreamType } from "./manifest/types.js";

export type { UpstreamType };

export type RetryPolicy = "none" | "safe-idempotent";

export interface ToolPolicy {
	concurrency: number;
	timeoutMs: number;
	retryPolicy: RetryPolicy;
	sideEffecting: boolean;
}

export interface NormalizedToolCall {
	toolName: string;
	input: Record<string, unknown>;
	secretRefs: string[];
	policy: ToolPolicy;
	correlationId: string;
}

export type NormalizedContentItem =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "resource"; resource: Record<string, unknown> };

export interface NormalizedToolResult {
	content: NormalizedContentItem[];
	structuredContent?: unknown;
	isError?: boolean;
	meta?: {
		durationMs: number;
		upstreamRequestId?: string;
		exitCode?: number;
		httpStatus?: number;
	};
}

export interface AdapterLogger {
	debug(message: string, fields?: Record<string, unknown>): void;
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
}

export interface AdapterContext {
	upstreamName: string;
	secrets: Record<string, string>;
	logger: AdapterLogger;
}

export interface UpstreamAdapter {
	readonly type: UpstreamType;
	init(context: AdapterContext): Promise<void>;
	call(call: NormalizedToolCall): Promise<NormalizedToolResult>;
	dispose(): Promise<void>;
}
