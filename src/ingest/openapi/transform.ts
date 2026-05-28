import type { Tool } from "../../manifest/types.js";
import {
	buildToolName,
	deriveActionFromVerbPath,
	isValidNamespace,
	isValidToolName,
	normaliseOperationId,
} from "./naming.js";
import type {
	HttpMethod,
	ParsedOperation,
	ParsedParameter,
	ParsedSpec,
} from "./types.js";

export interface TransformOptions {
	group: string;
	authProfile?: string;
	baseUrl?: string;
}

export interface TransformResult {
	tools: Tool[];
	warnings: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DESCRIPTION_LEN = 300;
const MAX_POLY_DEPTH = 3;

export function transformSpec(
	spec: ParsedSpec,
	opts: TransformOptions,
): TransformResult {
	if (!isValidNamespace(opts.group)) {
		throw new Error(
			`group '${opts.group}' must match ^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$`,
		);
	}
	const baseUrl = opts.baseUrl ?? spec.info.defaultBaseUrl;
	if (!baseUrl) {
		throw new Error(
			"baseUrl required: spec has no `servers[].url` and --base-url was not supplied",
		);
	}

	const warnings: string[] = [];
	const seen = new Map<string, string>();
	const tools: Tool[] = [];

	for (const op of spec.operations) {
		const action = op.operationId
			? normaliseOperationId(op.operationId)
			: deriveActionFromVerbPath(op.method, op.path);
		const name = buildToolName(opts.group, action);
		if (!isValidToolName(name)) {
			warnings.push(
				`derived tool name '${name}' does not match ADR-005 regex — operation ${op.method} ${op.path} skipped`,
			);
			continue;
		}
		const sourceKey = `${op.method} ${op.path}`;
		const prev = seen.get(name);
		if (prev) {
			throw new Error(
				`tool name collision after derivation: '${name}' produced by both ${prev} and ${sourceKey}`,
			);
		}
		seen.set(name, sourceKey);

		const tool = buildTool(op, name, baseUrl, opts, warnings);
		tools.push(tool);
	}

	return { tools: tools.map(sortToolKeys), warnings };
}

function buildTool(
	op: ParsedOperation,
	name: string,
	baseUrl: string,
	opts: TransformOptions,
	warnings: string[],
): Tool {
	const description = clipDescription(
		op.summary ?? op.description ?? `${op.method} ${op.path}`,
	);

	const tags = Array.from(new Set([...op.tags, opts.group]));

	const ext = op.rawNode as Record<string, unknown>;
	const tplTimeout =
		typeof ext["x-choda-timeout-ms"] === "number"
			? (ext["x-choda-timeout-ms"] as number)
			: undefined;
	const opAuthProfile =
		typeof ext["x-choda-auth-profile"] === "string"
			? (ext["x-choda-auth-profile"] as string)
			: undefined;

	const policy = executionDefaults(op.method);

	const pathParams = op.parameters.filter((p) => p.in === "path");
	const queryParams = op.parameters.filter((p) => p.in === "query");
	const headerParams = op.parameters.filter((p) => p.in === "header");

	const url = renderUrlTemplate(baseUrl, op.path, queryParams);
	const headers = renderHeaderTemplate(headerParams);
	const inputSchema = buildInputSchema(
		op,
		pathParams,
		queryParams,
		headerParams,
		warnings,
		`${op.method} ${op.path}`,
	);
	const bodyTemplate = renderBodyTemplate(op, warnings);

	const tool: Tool = {
		name,
		description,
		inputSchema,
		tags,
		upstream: {
			type: "rest",
			method: op.method,
			url,
			...(headers ? { headers } : {}),
			...(bodyTemplate !== undefined ? { bodyTemplate } : {}),
		},
		concurrency: policy.concurrency,
		timeoutMs: tplTimeout ?? DEFAULT_TIMEOUT_MS,
		retryPolicy: policy.retryPolicy,
		sideEffecting: policy.sideEffecting,
		...((opAuthProfile ?? opts.authProfile)
			? { authProfile: opAuthProfile ?? opts.authProfile }
			: {}),
	};
	return tool;
}

function executionDefaults(method: HttpMethod): {
	concurrency: number;
	retryPolicy: "none" | "safe-idempotent";
	sideEffecting: boolean;
} {
	if (method === "GET") {
		return {
			concurrency: 8,
			retryPolicy: "safe-idempotent",
			sideEffecting: false,
		};
	}
	return { concurrency: 4, retryPolicy: "none", sideEffecting: true };
}

function renderUrlTemplate(
	baseUrl: string,
	path: string,
	queryParams: ParsedParameter[],
): string {
	const base = baseUrl.replace(/\/+$/, "");
	const templatedPath = path.replace(/\{([^}]+)\}/g, (_m, name) => {
		return `{{input.${name}}}`;
	});
	const required = queryParams.filter((p) => p.required);
	if (required.length === 0) return `${base}${templatedPath}`;
	const qs = required
		.map((p) => `${encodeURIComponent(p.name)}={{input.${p.name}}}`)
		.join("&");
	const sep = templatedPath.includes("?") ? "&" : "?";
	return `${base}${templatedPath}${sep}${qs}`;
}

function renderHeaderTemplate(
	headerParams: ParsedParameter[],
): Record<string, string> | undefined {
	const required = headerParams.filter((p) => p.required);
	if (required.length === 0) return undefined;
	const headers: Record<string, string> = {};
	for (const p of required) {
		headers[p.name] = `{{input.${p.name}}}`;
	}
	return headers;
}

function renderBodyTemplate(op: ParsedOperation, warnings: string[]): unknown {
	if (!op.requestBody) return undefined;
	const schema = op.requestBody.schema;
	const props = (schema as { properties?: Record<string, unknown> }).properties;
	if (!props || typeof props !== "object") {
		warnings.push(
			`${op.method} ${op.path}: requestBody schema has no top-level properties; emitting passthrough bodyTemplate { "_body": "{{input._body}}" } — review the fragment before use`,
		);
		return { _body: "{{input._body}}" };
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(props).sort()) {
		out[key] = `{{input.${key}}}`;
	}
	return out;
}

function buildInputSchema(
	op: ParsedOperation,
	pathParams: ParsedParameter[],
	queryParams: ParsedParameter[],
	headerParams: ParsedParameter[],
	warnings: string[],
	where: string,
): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];

	const addParam = (p: ParsedParameter) => {
		properties[p.name] = flattenPoly(
			p.schema ?? { type: "string" },
			0,
			warnings,
			`${where}.${p.name}`,
		);
		if (p.required) required.push(p.name);
	};
	for (const p of pathParams) addParam(p);
	for (const p of queryParams) addParam(p);
	for (const p of headerParams) addParam(p);

	if (op.requestBody) {
		const schema = op.requestBody.schema;
		const props =
			(schema as { properties?: Record<string, unknown> }).properties ?? {};
		const reqList =
			(schema as { required?: string[] }).required ??
			(op.requestBody.required ? Object.keys(props) : []);
		for (const key of Object.keys(props).sort()) {
			properties[key] = flattenPoly(
				props[key] as Record<string, unknown>,
				0,
				warnings,
				`${where}.body.${key}`,
			);
		}
		if (Array.isArray(reqList)) {
			for (const r of reqList) {
				if (!required.includes(r)) required.push(r);
			}
		}
		if (!Object.keys(props).length) {
			// passthrough fallback to match bodyTemplate
			properties._body = { type: "object" };
			if (op.requestBody.required && !required.includes("_body")) {
				required.push("_body");
			}
		}
	}

	const schema: Record<string, unknown> = {
		type: "object",
		properties: sortObjectKeys(properties),
	};
	if (required.length > 0) {
		required.sort();
		schema.required = required;
	}
	return schema;
}

function flattenPoly(
	schema: Record<string, unknown> | undefined,
	depth: number,
	warnings: string[],
	where: string,
): Record<string, unknown> {
	if (!schema || typeof schema !== "object") return { type: "string" };
	const isPoly = "oneOf" in schema || "anyOf" in schema || "allOf" in schema;
	if (isPoly && depth >= MAX_POLY_DEPTH) {
		warnings.push(
			`${where}: polymorphic schema (oneOf/anyOf/allOf) exceeds depth ${MAX_POLY_DEPTH} — flattened to { type: "object" }`,
		);
		return { type: "object" };
	}
	if (Array.isArray(schema)) return { type: "string" };
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(schema)) {
		if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
			const sub: Record<string, unknown> = {};
			for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
				sub[pk] = flattenPoly(
					pv as Record<string, unknown>,
					depth + 1,
					warnings,
					`${where}.${pk}`,
				);
			}
			out[k] = sub;
		} else if (
			Array.isArray(v) &&
			(k === "oneOf" || k === "anyOf" || k === "allOf")
		) {
			out[k] = v.map((entry, idx) =>
				flattenPoly(
					entry as Record<string, unknown>,
					depth + 1,
					warnings,
					`${where}.${k}[${idx}]`,
				),
			);
		} else {
			out[k] = v;
		}
	}
	return out;
}

function clipDescription(s: string): string {
	const trimmed = s.trim();
	if (trimmed.length <= MAX_DESCRIPTION_LEN) return trimmed;
	return `${trimmed.slice(0, MAX_DESCRIPTION_LEN - 1)}…`;
}

function sortObjectKeys<T>(obj: T): T {
	if (obj === null || typeof obj !== "object") return obj;
	if (Array.isArray(obj)) return obj.map(sortObjectKeys) as unknown as T;
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(obj as Record<string, unknown>).sort()) {
		out[k] = sortObjectKeys((obj as Record<string, unknown>)[k]);
	}
	return out as unknown as T;
}

/**
 * Reorder keys so the tool's JSON is byte-stable across runs (same input
 * spec → identical output bytes). Top-level keys follow the ToolSchema
 * order; nested objects sort alphabetically.
 */
function sortToolKeys(tool: Tool): Tool {
	const ordered: Record<string, unknown> = {
		name: tool.name,
		description: tool.description,
		inputSchema: sortObjectKeys(tool.inputSchema),
		tags: [...tool.tags].sort(),
		upstream: sortObjectKeys(tool.upstream as unknown),
		concurrency: tool.concurrency,
		timeoutMs: tool.timeoutMs,
		retryPolicy: tool.retryPolicy,
		sideEffecting: tool.sideEffecting,
	};
	if (tool.authProfile) ordered.authProfile = tool.authProfile;
	return ordered as unknown as Tool;
}
