import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ManifestError } from "./errors.js";
import { GatewayConfigSchema, ToolsManifestSchema } from "./schema.js";
import type { GatewayConfig, ToolsManifest } from "./types.js";

export interface LoadToolsManifestOptions {
	/**
	 * When provided, every tool entry that declares `authProfile` is checked
	 * against this set; unknown profiles throw `ManifestError` naming both the
	 * tool and the missing profile. Pass `undefined` to skip cross-validation.
	 */
	knownProfiles?: ReadonlySet<string>;
}

export async function loadToolsManifest(
	path: string,
	opts: LoadToolsManifestOptions = {},
): Promise<ToolsManifest> {
	const raw = await readFileOrThrow(path);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new ManifestError(`malformed JSON in ${path}`, cause);
	}
	const result = ToolsManifestSchema.safeParse(parsed);
	if (!result.success) {
		throw new ManifestError(
			`tools manifest validation failed:\n${formatIssues(result.error.issues)}`,
			result.error,
		);
	}
	assertUniqueNames(result.data);
	if (opts.knownProfiles) {
		assertAuthProfilesReferenced(result.data, opts.knownProfiles);
	}
	return result.data;
}

export function assertAuthProfilesReferenced(
	manifest: ToolsManifest,
	knownProfiles: ReadonlySet<string>,
): void {
	const missing: string[] = [];
	for (const tool of manifest.tools) {
		if (tool.authProfile && !knownProfiles.has(tool.authProfile)) {
			missing.push(`${tool.name} -> ${tool.authProfile}`);
		}
	}
	if (missing.length > 0) {
		throw new ManifestError(
			`tool(s) reference unknown auth profile(s): ${missing.join("; ")}`,
		);
	}
}

export async function loadGatewayConfig(path: string): Promise<{
	config: GatewayConfig;
	configDir: string;
	resolvedToolsPath: string;
	resolvedAuditPath: string;
}> {
	const raw = await readFileOrThrow(path);
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (cause) {
		throw new ManifestError(`malformed YAML in ${path}`, cause);
	}
	const result = GatewayConfigSchema.safeParse(parsed);
	if (!result.success) {
		throw new ManifestError(
			`gateway config validation failed:\n${formatIssues(result.error.issues)}`,
			result.error,
		);
	}
	const configDir = dirname(resolve(path));
	return {
		config: result.data,
		configDir,
		resolvedToolsPath: resolveRelative(result.data.toolsPath, configDir),
		resolvedAuditPath: resolveRelative(result.data.auditPath, configDir),
	};
}

function resolveRelative(target: string, baseDir: string): string {
	return isAbsolute(target) ? target : resolve(baseDir, target);
}

async function readFileOrThrow(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (cause) {
		throw new ManifestError(`cannot read file: ${path}`, cause);
	}
}

function assertUniqueNames(manifest: ToolsManifest): void {
	const seen = new Map<string, number>();
	const duplicates: string[] = [];
	manifest.tools.forEach((tool, index) => {
		const prev = seen.get(tool.name);
		if (prev !== undefined) {
			duplicates.push(`${tool.name} (indices ${prev}, ${index})`);
		} else {
			seen.set(tool.name, index);
		}
	});
	if (duplicates.length > 0) {
		throw new ManifestError(`duplicate tool name(s): ${duplicates.join("; ")}`);
	}
}

function formatIssues(
	issues: { path: PropertyKey[]; message: string }[],
): string {
	return issues
		.map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
		.join("\n");
}
