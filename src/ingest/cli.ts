import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Tool } from "../manifest/types.js";
import { parseSpec } from "./openapi/parser.js";
import { transformSpec } from "./openapi/transform.js";

export interface IngestCommandArgs {
	specPath: string;
	group: string;
	authProfile?: string;
	outPath?: string;
	baseUrl?: string;
	check?: boolean;
	authProfilesPath?: string;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
}

export interface IngestCommandResult {
	exitCode: number;
	outPath: string;
	written: boolean;
	toolCount: number;
	warnings: string[];
}

export async function runIngest(
	args: IngestCommandArgs,
): Promise<IngestCommandResult> {
	const stdout = args.stdout ?? ((s: string) => process.stdout.write(s));
	const stderr = args.stderr ?? ((s: string) => process.stderr.write(s));

	const spec = await parseSpec(args.specPath);
	const transform = transformSpec(spec, {
		group: args.group,
		authProfile: args.authProfile,
		baseUrl: args.baseUrl,
	});

	const warnings = [...spec.warnings, ...transform.warnings];
	for (const w of warnings) stderr(`warn: ${w}\n`);

	if (args.authProfile) {
		const declared = await listDeclaredProfiles(args.authProfilesPath);
		if (declared && !declared.has(args.authProfile)) {
			stderr(
				`warn: --auth-profile '${args.authProfile}' is not (yet) declared in auth-profiles.yaml — declare it before runtime\n`,
			);
		}
	}

	const outPath = resolve(
		args.outPath ?? defaultOutPath(args.group, args.specPath),
	);
	const manifest = { tools: transform.tools };
	const newJson = `${JSON.stringify(manifest, null, 2)}\n`;

	if (args.check) {
		if (!existsSync(outPath)) {
			stderr(`drift: ${outPath} does not exist\n`);
			return {
				exitCode: 1,
				outPath,
				written: false,
				toolCount: transform.tools.length,
				warnings,
			};
		}
		const existingRaw = await readFile(outPath, "utf8");
		if (existingRaw === newJson) {
			stdout(`up-to-date: ${outPath}\n`);
			return {
				exitCode: 0,
				outPath,
				written: false,
				toolCount: transform.tools.length,
				warnings,
			};
		}
		const diff = summariseDiff(existingRaw, manifest);
		stderr(`drift: ${outPath}\n${diff}\n`);
		return {
			exitCode: 1,
			outPath,
			written: false,
			toolCount: transform.tools.length,
			warnings,
		};
	}

	await mkdir(dirname(outPath), { recursive: true });
	await writeFile(outPath, newJson, "utf8");
	stdout(`wrote ${transform.tools.length} tool(s) → ${outPath}\n`);
	return {
		exitCode: 0,
		outPath,
		written: true,
		toolCount: transform.tools.length,
		warnings,
	};
}

function defaultOutPath(group: string, specPath: string): string {
	const base = basename(specPath, extname(specPath));
	return `tools/${group}.${base}.json`;
}

async function listDeclaredProfiles(
	pathOverride?: string,
): Promise<Set<string> | null> {
	const path = pathOverride ?? "./auth-profiles.yaml";
	if (!existsSync(path)) return null;
	const raw = await readFile(path, "utf8");
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const profiles = (parsed as { profiles?: unknown }).profiles;
	if (!profiles || typeof profiles !== "object") return new Set();
	return new Set(Object.keys(profiles as Record<string, unknown>));
}

interface ManifestFile {
	tools: Tool[];
}

function summariseDiff(existingRaw: string, fresh: ManifestFile): string {
	let existing: ManifestFile;
	try {
		existing = JSON.parse(existingRaw) as ManifestFile;
	} catch {
		return "  existing fragment is not valid JSON";
	}
	const existingByName = new Map(
		(existing.tools ?? []).map((t) => [t.name, t]),
	);
	const freshByName = new Map(fresh.tools.map((t) => [t.name, t]));
	const added: string[] = [];
	const removed: string[] = [];
	const changed: string[] = [];
	for (const name of freshByName.keys()) {
		if (!existingByName.has(name)) {
			added.push(name);
			continue;
		}
		if (
			JSON.stringify(existingByName.get(name)) !==
			JSON.stringify(freshByName.get(name))
		) {
			changed.push(name);
		}
	}
	for (const name of existingByName.keys()) {
		if (!freshByName.has(name)) removed.push(name);
	}
	const lines: string[] = [];
	if (added.length)
		lines.push(`  + ${added.length} added: ${added.join(", ")}`);
	if (removed.length)
		lines.push(`  - ${removed.length} removed: ${removed.join(", ")}`);
	if (changed.length)
		lines.push(`  ~ ${changed.length} changed: ${changed.join(", ")}`);
	if (lines.length === 0) lines.push("  fragment text differs but tools match");
	return lines.join("\n");
}
