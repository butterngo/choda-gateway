import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	type HttpMethod,
	OpenApiParseError,
	type ParsedOperation,
	type ParsedParameter,
	type ParsedRequestBody,
	type ParsedSpec,
	type ParsedSpecInfo,
	SUPPORTED_METHODS,
} from "./types.js";

interface SpecRoot {
	openapi?: string;
	swagger?: string;
	info?: {
		title?: string;
		version?: string;
		description?: string;
	};
	servers?: Array<{ url?: string }>;
	paths?: Record<string, unknown>;
	components?: Record<string, unknown>;
	webhooks?: Record<string, unknown>;
}

const METHOD_KEYS: readonly string[] = SUPPORTED_METHODS.map((m) =>
	m.toLowerCase(),
);

const UNSUPPORTED_METHOD_KEYS: readonly string[] = ["head", "options", "trace"];

export async function parseSpec(filePath: string): Promise<ParsedSpec> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (cause) {
		throw new OpenApiParseError(`cannot read spec: ${filePath}`, cause);
	}
	const root = decode(filePath, raw);
	if (!root || typeof root !== "object" || Array.isArray(root)) {
		throw new OpenApiParseError(`spec root must be an object: ${filePath}`);
	}
	const spec = root as SpecRoot;
	if (spec.swagger) {
		throw new OpenApiParseError(
			`OpenAPI 2.0 (Swagger) is not supported — got swagger=${String(spec.swagger)}; upgrade to 3.0.x or 3.1.x`,
		);
	}
	const version = spec.openapi;
	if (!version) {
		throw new OpenApiParseError(
			"missing `openapi` version field (expected 3.0.x or 3.1.x)",
		);
	}
	if (!/^3\.[01]\./.test(version) && version !== "3.0" && version !== "3.1") {
		throw new OpenApiParseError(
			`unsupported OpenAPI version '${version}' (expected 3.0.x or 3.1.x)`,
		);
	}

	const info: ParsedSpecInfo = {
		title: spec.info?.title ?? "<untitled>",
		version: spec.info?.version ?? "0.0.0",
		description: spec.info?.description,
		openapiVersion: version,
		defaultBaseUrl: spec.servers?.find((s) => typeof s.url === "string")?.url,
	};

	const warnings: string[] = [];
	const operations: ParsedOperation[] = [];

	if (spec.webhooks && Object.keys(spec.webhooks).length > 0) {
		warnings.push(
			`webhooks ignored (${Object.keys(spec.webhooks).length} entries) — v1 only supports paths`,
		);
	}

	const paths = spec.paths ?? {};
	for (const [pathKey, pathItem] of Object.entries(paths)) {
		if (!pathItem || typeof pathItem !== "object" || Array.isArray(pathItem)) {
			warnings.push(`path '${pathKey}' is not an object — skipped`);
			continue;
		}
		const item = pathItem as Record<string, unknown>;
		const pathLevelParseResult = parseParameters(
			(item.parameters as unknown[]) ?? [],
			spec,
			`paths.${pathKey}.parameters`,
			warnings,
		);
		const pathLevelParameters = pathLevelParseResult.params;

		for (const [methodKey, opNode] of Object.entries(item)) {
			const lower = methodKey.toLowerCase();
			if (UNSUPPORTED_METHOD_KEYS.includes(lower)) {
				warnings.push(
					`paths.${pathKey}.${methodKey}: HTTP method '${methodKey}' is not supported in v1 — skipped`,
				);
				continue;
			}
			if (!METHOD_KEYS.includes(lower)) continue;
			if (!opNode || typeof opNode !== "object" || Array.isArray(opNode)) {
				warnings.push(
					`paths.${pathKey}.${methodKey} is not an object — skipped`,
				);
				continue;
			}
			const method = methodKey.toUpperCase() as HttpMethod;
			const parsed = parseOperation(
				method,
				pathKey,
				opNode as Record<string, unknown>,
				pathLevelParameters,
				spec,
				warnings,
			);
			if (parsed) operations.push(parsed);
		}
	}

	return { info, operations, warnings };
}

function decode(path: string, raw: string): unknown {
	const ext = extname(path).toLowerCase();
	if (ext === ".json") {
		try {
			return JSON.parse(raw);
		} catch (cause) {
			throw new OpenApiParseError(`malformed JSON in ${path}`, cause);
		}
	}
	try {
		return parseYaml(raw);
	} catch (cause) {
		throw new OpenApiParseError(`malformed YAML in ${path}`, cause);
	}
}

function parseOperation(
	method: HttpMethod,
	path: string,
	node: Record<string, unknown>,
	pathLevelParameters: ParsedParameter[],
	spec: SpecRoot,
	warnings: string[],
): ParsedOperation | null {
	const where = `paths.${path}.${method.toLowerCase()}`;

	if (node.callbacks) {
		warnings.push(`${where}: callbacks are not supported in v1 — skipped`);
		return null;
	}

	const operationId =
		typeof node.operationId === "string" ? node.operationId : undefined;
	const summary = typeof node.summary === "string" ? node.summary : undefined;
	const description =
		typeof node.description === "string" ? node.description : undefined;
	const tags = Array.isArray(node.tags)
		? (node.tags as unknown[]).filter((t): t is string => typeof t === "string")
		: [];

	const opParameters = parseParameters(
		(node.parameters as unknown[]) ?? [],
		spec,
		`${where}.parameters`,
		warnings,
	);

	if (opParameters.hadRemoteRef) {
		warnings.push(
			`${where}: parameters contain remote $ref — operation skipped (v1 supports local $refs only)`,
		);
		return null;
	}

	const parameters = mergeParameters(pathLevelParameters, opParameters.params);

	let requestBody: ParsedRequestBody | undefined;
	if (node.requestBody !== undefined) {
		const rb = resolveRef(node.requestBody, spec, `${where}.requestBody`);
		if (!rb.ok) {
			warnings.push(rb.warning);
			return null;
		}
		const body = rb.value;
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			warnings.push(`${where}.requestBody is not an object — skipped`);
			return null;
		}
		const content = (body as { content?: Record<string, unknown> }).content;
		if (!content || typeof content !== "object") {
			warnings.push(`${where}.requestBody has no content — operation skipped`);
			return null;
		}
		const contentTypes = Object.keys(content);
		if (
			contentTypes.includes("multipart/form-data") ||
			contentTypes.includes("application/octet-stream")
		) {
			warnings.push(
				`${where}: requestBody contentType ${contentTypes.join(",")} not supported in v1 — operation skipped`,
			);
			return null;
		}
		const jsonEntry =
			content["application/json"] ?? content["application/vnd.api+json"];
		if (!jsonEntry || typeof jsonEntry !== "object") {
			warnings.push(
				`${where}: requestBody must include application/json — operation skipped`,
			);
			return null;
		}
		const required =
			typeof (body as { required?: unknown }).required === "boolean"
				? (body as { required: boolean }).required
				: false;
		const schemaRaw = (jsonEntry as { schema?: unknown }).schema;
		const schemaResolved = resolveSchemaTree(
			schemaRaw,
			spec,
			`${where}.requestBody`,
		);
		requestBody = {
			required,
			schema: (schemaResolved as Record<string, unknown>) ?? {},
		};
	}

	const responses: Record<string, Record<string, unknown>> = {};
	if (node.responses && typeof node.responses === "object") {
		for (const [code, respNode] of Object.entries(
			node.responses as Record<string, unknown>,
		)) {
			const resolved = resolveRef(respNode, spec, `${where}.responses.${code}`);
			if (!resolved.ok) {
				warnings.push(resolved.warning);
				continue;
			}
			if (resolved.value && typeof resolved.value === "object") {
				responses[code] = resolved.value as Record<string, unknown>;
				const content = (
					resolved.value as { content?: Record<string, unknown> }
				).content;
				if (content) {
					const types = Object.keys(content);
					if (
						types.includes("text/event-stream") ||
						types.includes("application/octet-stream")
					) {
						warnings.push(
							`${where}.responses.${code}: streaming/binary response (${types.join(",")}) — gateway passes through as text`,
						);
					}
				}
			}
		}
	}

	const securitySchemes = extractSecuritySchemes(spec);

	return {
		method,
		path,
		operationId,
		summary,
		description,
		tags,
		parameters,
		requestBody,
		responses,
		securitySchemes,
		rawNode: node,
	};
}

interface ParseParametersResult {
	params: ParsedParameter[];
	hadRemoteRef: boolean;
}

function parseParameters(
	raw: unknown[],
	spec: SpecRoot,
	where: string,
	warnings: string[],
): ParseParametersResult {
	const out: ParsedParameter[] = [];
	let hadRemoteRef = false;
	for (let i = 0; i < raw.length; i++) {
		const entry = raw[i];
		const resolved = resolveRef(entry, spec, `${where}[${i}]`);
		if (!resolved.ok) {
			warnings.push(resolved.warning);
			if (/remote \$ref/.test(resolved.warning)) hadRemoteRef = true;
			continue;
		}
		const p = resolved.value as Record<string, unknown>;
		if (typeof p.name !== "string" || typeof p.in !== "string") {
			warnings.push(`${where}[${i}]: parameter missing name/in — dropped`);
			continue;
		}
		if (p.in === "cookie") {
			warnings.push(
				`${where}[${i}]: parameter location 'cookie' not supported in v1 — dropped`,
			);
			continue;
		}
		if (p.in !== "path" && p.in !== "query" && p.in !== "header") {
			warnings.push(
				`${where}[${i}]: unknown parameter location '${String(p.in)}' — dropped`,
			);
			continue;
		}
		out.push({
			name: p.name,
			in: p.in,
			required:
				p.in === "path"
					? true
					: typeof p.required === "boolean"
						? p.required
						: false,
			description:
				typeof p.description === "string" ? p.description : undefined,
			schema: resolveSchemaTree(p.schema, spec, `${where}[${i}].schema`) as
				| Record<string, unknown>
				| undefined,
		});
	}
	return { params: out, hadRemoteRef };
}

function mergeParameters(
	pathLevel: ParsedParameter[],
	opLevel: ParsedParameter[],
): ParsedParameter[] {
	const seen = new Set<string>();
	const out: ParsedParameter[] = [];
	for (const p of opLevel) {
		seen.add(`${p.in}:${p.name}`);
		out.push(p);
	}
	for (const p of pathLevel) {
		if (seen.has(`${p.in}:${p.name}`)) continue;
		out.push(p);
	}
	return out;
}

type RefResult = { ok: true; value: unknown } | { ok: false; warning: string };

function resolveRef(node: unknown, spec: SpecRoot, where: string): RefResult {
	if (!node || typeof node !== "object" || Array.isArray(node)) {
		return { ok: true, value: node };
	}
	const r = (node as { $ref?: unknown }).$ref;
	if (typeof r !== "string") return { ok: true, value: node };
	if (!r.startsWith("#/")) {
		return {
			ok: false,
			warning: `${where}: external/remote $ref '${r}' not supported in v1 — operation/parameter dropped`,
		};
	}
	const segments = r.slice(2).split("/").map(decodePointerSegment);
	let cur: unknown = spec;
	for (const seg of segments) {
		if (cur === null || cur === undefined || typeof cur !== "object") {
			return {
				ok: false,
				warning: `${where}: $ref '${r}' could not be resolved`,
			};
		}
		cur = (cur as Record<string, unknown>)[seg];
	}
	if (cur === undefined) {
		return {
			ok: false,
			warning: `${where}: $ref '${r}' resolves to undefined`,
		};
	}
	return { ok: true, value: cur };
}

function decodePointerSegment(s: string): string {
	return s.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveSchemaTree(
	node: unknown,
	spec: SpecRoot,
	where: string,
	depth = 0,
): unknown {
	if (depth > 16) return node;
	if (!node || typeof node !== "object") return node;
	if (Array.isArray(node)) {
		return node.map((v) => resolveSchemaTree(v, spec, where, depth + 1));
	}
	const obj = node as Record<string, unknown>;
	if (typeof obj.$ref === "string") {
		const r = resolveRef(obj, spec, where);
		if (!r.ok) return obj;
		return resolveSchemaTree(r.value, spec, where, depth + 1);
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		out[k] = resolveSchemaTree(v, spec, where, depth + 1);
	}
	return out;
}

function extractSecuritySchemes(
	spec: SpecRoot,
): Record<string, Record<string, unknown>> | undefined {
	const components = spec.components as
		| { securitySchemes?: Record<string, Record<string, unknown>> }
		| undefined;
	const schemes = components?.securitySchemes;
	if (!schemes || typeof schemes !== "object") return undefined;
	return schemes;
}
