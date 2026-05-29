import { Ajv, type ValidateFunction } from "ajv";
import type { AuditLogger } from "./audit/logger.js";
import type { AuditEntry, UpstreamType } from "./audit/types.js";
import type { CredentialProvider } from "./auth/types.js";
import type { Tool } from "./manifest/types.js";
import type { SecretStore } from "./secrets/store.js";
import type {
	AdapterContext,
	AdapterLogger,
	NormalizedToolResult,
	UpstreamAdapter,
} from "./types.js";
import { createAdapter } from "./upstream/upstream-adapter.js";
import { generateCorrId } from "./util/ids.js";

const NOOP_LOGGER: AdapterLogger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

export class ToolNotFoundError extends Error {
	constructor(public readonly toolName: string) {
		super(`unknown tool: ${toolName}`);
		this.name = "ToolNotFoundError";
	}
}

export class InputValidationError extends Error {
	constructor(
		public readonly toolName: string,
		public readonly issues: string,
	) {
		super(`invalid input for ${toolName}: ${issues}`);
		this.name = "InputValidationError";
	}
}

export type RouterAdapterFactory = (tool: Tool) => UpstreamAdapter;

export interface RouterOptions {
	tools: Tool[];
	secretStore: SecretStore;
	auditLogger: AuditLogger;
	profile: string;
	logger?: AdapterLogger;
	/**
	 * Override the adapter factory for tests. Defaults to `createAdapter`.
	 */
	adapterFactory?: RouterAdapterFactory;
	/**
	 * Auth-profile registry from `loadProfiles` + `createProviderRegistry`.
	 * Forwarded to `createAdapter` so REST tools with `authProfile` resolve a
	 * `CredentialProvider` per call. Tools without `authProfile` are unaffected.
	 */
	credentialProviders?: ReadonlyMap<string, CredentialProvider>;
}

export interface ToolListItem {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface Router {
	listTools(): ToolListItem[];
	call(
		toolName: string,
		input: Record<string, unknown>,
	): Promise<NormalizedToolResult>;
	dispose(): Promise<void>;
}

interface CompiledTool {
	tool: Tool;
	adapter: UpstreamAdapter;
	validate: ValidateFunction;
	secretRefs: string[];
}

const SECRET_PLACEHOLDER = /\{\{\s*secrets\.([A-Z][A-Z0-9_]*)\s*\}\}/g;

function collectSecretRefs(tool: Tool): string[] {
	const names = new Set<string>();
	walkStrings(tool.upstream as unknown, (s) => {
		for (const match of s.matchAll(SECRET_PLACEHOLDER)) {
			names.add(match[1]);
		}
	});
	return [...names].sort();
}

function walkStrings(value: unknown, cb: (s: string) => void): void {
	if (typeof value === "string") {
		cb(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) walkStrings(v, cb);
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const v of Object.values(value as Record<string, unknown>)) {
			walkStrings(v, cb);
		}
	}
}

export async function createRouter(opts: RouterOptions): Promise<Router> {
	const factory: RouterAdapterFactory =
		opts.adapterFactory ??
		((tool) =>
			createAdapter(tool, { credentialProviders: opts.credentialProviders }));
	const logger = opts.logger ?? NOOP_LOGGER;
	// useDefaults lets a tool's inputSchema declare `"default"` for optional
	// fields; Ajv injects the value into `input` in place before it reaches the
	// template engine, which throws on any unresolved `{{input.x}}`. This keeps
	// optional body/url params (e.g. an empty `keyword` search) working without
	// the caller having to pass them. Only fires where a schema declares a default.
	const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
	const compiled = new Map<string, CompiledTool>();

	for (const tool of opts.tools) {
		const adapter = factory(tool);
		await adapter.init({
			upstreamName: tool.name,
			secrets: {}, // adapter context populated per-call below
			logger,
		});
		compiled.set(tool.name, {
			tool,
			adapter,
			validate: ajv.compile(tool.inputSchema),
			secretRefs: collectSecretRefs(tool),
		});
	}

	return {
		listTools(): ToolListItem[] {
			return [...compiled.values()].map((c) => ({
				name: c.tool.name,
				description: c.tool.description,
				inputSchema: c.tool.inputSchema,
			}));
		},
		async call(
			toolName: string,
			input: Record<string, unknown>,
		): Promise<NormalizedToolResult> {
			const entry = compiled.get(toolName);
			if (!entry) throw new ToolNotFoundError(toolName);
			return executeCall(entry, input, opts, factory, logger);
		},
		async dispose(): Promise<void> {
			for (const c of compiled.values()) {
				try {
					await c.adapter.dispose();
				} catch (err) {
					logger.warn("adapter dispose failed", {
						tool: c.tool.name,
						error: String(err),
					});
				}
			}
			compiled.clear();
		},
	};
}

async function executeCall(
	entry: CompiledTool,
	input: Record<string, unknown>,
	opts: RouterOptions,
	_factory: RouterAdapterFactory,
	logger: AdapterLogger,
): Promise<NormalizedToolResult> {
	const { tool, adapter, validate, secretRefs } = entry;
	const correlationId = generateCorrId();
	const t0 = performance.now();
	const upstreamType = tool.upstream.type as UpstreamType;

	const baseAudit = {
		corrId: correlationId,
		toolName: tool.name,
		profile: opts.profile,
	};

	await safeAudit(
		opts.auditLogger,
		{
			...baseAudit,
			event: "request.received",
			ts: nowIso(),
			input,
			secretRefs,
		},
		logger,
	);

	if (!validate(input)) {
		const issues =
			validate.errors
				?.map((e) => `${e.instancePath || "<root>"} ${e.message ?? ""}`.trim())
				.join("; ") ?? "unknown validation error";
		const errResult: NormalizedToolResult = {
			content: [{ type: "text", text: `invalid input: ${issues}` }],
			isError: true,
			meta: { durationMs: Math.round(performance.now() - t0) },
		};
		await safeAudit(
			opts.auditLogger,
			{
				...baseAudit,
				event: "response.returned",
				ts: nowIso(),
				durationMs: errResult.meta?.durationMs ?? 0,
				ok: false,
				errKind: "input_validation",
			},
			logger,
		);
		throw new InputValidationError(tool.name, issues);
	}

	// Resolve secrets the tool actually references.
	let secrets: Record<string, string>;
	try {
		secrets = await resolveSecrets(opts.secretStore, secretRefs);
	} catch (err) {
		const durationMs = Math.round(performance.now() - t0);
		await safeAudit(
			opts.auditLogger,
			{
				...baseAudit,
				event: "response.returned",
				ts: nowIso(),
				durationMs,
				ok: false,
				errKind: "secret_resolve",
			},
			logger,
		);
		throw err;
	}

	// Re-init adapter context with the resolved secret map for this call.
	// (Adapters store the ctx once at init time; we update by re-init since the
	// ctx.secrets contents are per-call. Adapters treat re-init as idempotent.)
	await adapter.init({
		upstreamName: tool.name,
		secrets,
		logger,
	});

	const upstreamStart = performance.now();
	await safeAudit(
		opts.auditLogger,
		{
			...baseAudit,
			event: "upstream.dispatched",
			ts: nowIso(),
			upstreamType,
			upstreamId: describeUpstream(tool),
			attempt: 1,
		},
		logger,
	);

	let result: NormalizedToolResult;
	let upstreamOk = true;
	let errKind: string | undefined;
	try {
		result = await adapter.call({
			toolName: tool.name,
			input,
			secretRefs,
			policy: {
				concurrency: tool.concurrency,
				timeoutMs: tool.timeoutMs,
				retryPolicy: tool.retryPolicy,
				sideEffecting: tool.sideEffecting,
			},
			correlationId,
		});
		if (result.isError) {
			upstreamOk = false;
			errKind = classifyResultError(result);
		}
	} catch (err) {
		upstreamOk = false;
		errKind = classifyThrownError(err);
		result = {
			content: [
				{
					type: "text",
					text: String(err instanceof Error ? err.message : err),
				},
			],
			isError: true,
			meta: { durationMs: Math.round(performance.now() - upstreamStart) },
		};
	}

	const upstreamDurationMs = Math.round(performance.now() - upstreamStart);
	await safeAudit(
		opts.auditLogger,
		{
			...baseAudit,
			event: "upstream.completed",
			ts: nowIso(),
			upstreamType,
			durationMs: upstreamDurationMs,
			ok: upstreamOk,
			...(errKind ? { errKind } : {}),
		},
		logger,
	);

	const totalMs = Math.round(performance.now() - t0);
	await safeAudit(
		opts.auditLogger,
		{
			...baseAudit,
			event: "response.returned",
			ts: nowIso(),
			durationMs: totalMs,
			ok: upstreamOk,
			...(errKind ? { errKind } : {}),
		},
		logger,
	);

	return result;
}

async function resolveSecrets(
	store: SecretStore,
	names: string[],
): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const name of names) {
		out[name] = await store.get(name);
	}
	return out;
}

function describeUpstream(tool: Tool): string {
	const u = tool.upstream;
	switch (u.type) {
		case "mcp":
			return `mcp:${u.remoteTool}@${u.command}`;
		case "rest":
			return `${u.method} ${u.url}`;
		case "cli":
			return `cli:${u.command}`;
	}
}

function classifyResultError(result: NormalizedToolResult): string {
	if (result.meta?.httpStatus !== undefined) {
		const s = result.meta.httpStatus;
		if (s >= 400) return `http_${s}`;
	}
	if (result.meta?.exitCode !== undefined && result.meta.exitCode !== 0) {
		return "cli_nonzero_exit";
	}
	return "upstream_error";
}

function classifyThrownError(err: unknown): string {
	if (!(err instanceof Error)) return "unknown";
	if (err.name === "AdapterTimeoutError") return "timeout";
	if (err.name === "McpUpstreamClosedError") return "crash";
	if (err.name === "SecretMissingError") return "secret_missing";
	if (err.name === "DecryptError") return "decrypt_error";
	return err.name || "unknown";
}

async function safeAudit(
	logger: AuditLogger,
	entry: AuditEntry,
	adapterLogger: AdapterLogger,
): Promise<void> {
	try {
		await logger.log(entry);
	} catch (err) {
		adapterLogger.warn("audit log failed", { error: String(err) });
	}
}

function nowIso(): string {
	return new Date().toISOString();
}
