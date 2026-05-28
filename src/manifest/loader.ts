import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ManifestError } from "./errors.js";
import { GatewayConfigSchema, ToolsManifestSchema } from "./schema.js";
import type { GatewayConfig, Tool, ToolsManifest } from "./types.js";

export interface LoadToolsManifestOptions {
	/**
	 * When provided, every tool entry that declares `authProfile` is checked
	 * against this set; unknown profiles throw `ManifestError` naming both the
	 * tool and the missing profile. Pass `undefined` to skip cross-validation.
	 */
	knownProfiles?: ReadonlySet<string>;
}

/**
 * Load a tools manifest from either:
 *   - a single JSON file (the historical `tools.json` shape, single source of
 *     truth), or
 *   - a directory containing `*.json` fragment files (the ADR-006 layout —
 *     one fragment per OpenAPI spec).
 *
 * Fragment files are loaded in alphabetical order so the resulting in-memory
 * manifest is deterministic. Tool-name uniqueness is enforced across the
 * merged set; collisions throw `ManifestError` naming both source files.
 */
export async function loadToolsManifest(
	path: string,
	opts: LoadToolsManifestOptions = {},
): Promise<ToolsManifest> {
	let isDir = false;
	try {
		const st = await stat(path);
		isDir = st.isDirectory();
	} catch (cause) {
		throw new ManifestError(`cannot read tools manifest: ${path}`, cause);
	}

	const data: ToolsManifest = isDir
		? await loadFragments(path)
		: await loadSingleFile(path);

	assertUniqueNames(data);
	if (opts.knownProfiles) {
		assertAuthProfilesReferenced(data, opts.knownProfiles);
	}
	return data;
}

async function loadSingleFile(path: string): Promise<ToolsManifest> {
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
	return result.data;
}

async function loadFragments(dir: string): Promise<ToolsManifest> {
	const entries = await readdir(dir);
	const fragmentFiles = entries.filter((e) => e.endsWith(".json")).sort();

	const tools: Tool[] = [];
	const provenance = new Map<string, string>();
	for (const file of fragmentFiles) {
		const full = join(dir, file);
		const fragment = await loadSingleFile(full);
		for (const tool of fragment.tools) {
			const prevFile = provenance.get(tool.name);
			if (prevFile) {
				throw new ManifestError(
					`duplicate tool name across fragments: '${tool.name}' in '${prevFile}' and '${file}'`,
				);
			}
			provenance.set(tool.name, file);
			tools.push(tool);
		}
	}

	if (tools.length === 0) {
		throw new ManifestError(
			`no tools loaded — ${dir} has no *.json fragments containing tools`,
		);
	}

	const merged: ToolsManifest = { tools };
	const result = ToolsManifestSchema.safeParse(merged);
	if (!result.success) {
		throw new ManifestError(
			`merged manifest failed validation:\n${formatIssues(result.error.issues)}`,
			result.error,
		);
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
