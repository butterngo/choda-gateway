import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManifestError } from "../../src/manifest/errors.js";
import {
	loadGatewayConfig,
	loadToolsManifest,
} from "../../src/manifest/loader.js";
import {
	makeCliTool,
	makeManifest,
	makeMcpTool,
	makeRestTool,
} from "./fixtures.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "manifest-loader-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeManifest(name: string, body: unknown): Promise<string> {
	const path = join(dir, name);
	await writeFile(
		path,
		typeof body === "string" ? body : JSON.stringify(body, null, 2),
		"utf8",
	);
	return path;
}

describe("loadToolsManifest", () => {
	it("loads + validates a 3-tool manifest (happy path)", async () => {
		const path = await writeManifest(
			"tools.json",
			makeManifest([makeMcpTool(), makeRestTool(), makeCliTool()]),
		);
		const manifest = await loadToolsManifest(path);
		expect(manifest.tools).toHaveLength(3);
		expect(manifest.tools.map((t) => t.name)).toEqual([
			"tasks__task_list",
			"linear__issue_search",
			"gh__pr_list",
		]);
	});

	it("error: malformed JSON", async () => {
		const path = await writeManifest("tools.json", "{ not valid json");
		await expect(loadToolsManifest(path)).rejects.toThrow(ManifestError);
		await expect(loadToolsManifest(path)).rejects.toThrow(/malformed JSON/);
	});

	it("error: duplicate tool name", async () => {
		const path = await writeManifest(
			"tools.json",
			makeManifest([makeMcpTool(), makeMcpTool()]),
		);
		await expect(loadToolsManifest(path)).rejects.toThrow(
			/duplicate tool name/,
		);
	});

	it("error: invalid tag (uppercase)", async () => {
		const path = await writeManifest(
			"tools.json",
			makeManifest([makeMcpTool({ tags: ["Coding"] })]),
		);
		await expect(loadToolsManifest(path)).rejects.toThrow(/tags/);
	});

	it("error: missing required field (description)", async () => {
		const t = makeMcpTool();
		// biome-ignore lint/performance/noDelete: test fixture mutation
		delete (t as Partial<typeof t>).description;
		const path = await writeManifest("tools.json", makeManifest([t]));
		await expect(loadToolsManifest(path)).rejects.toThrow(/description/);
	});

	it("error: unknown upstream type", async () => {
		const bad = {
			tools: [
				{
					...makeMcpTool(),
					upstream: { type: "ftp", url: "ftp://x" },
				},
			],
		};
		const path = await writeManifest("tools.json", bad);
		await expect(loadToolsManifest(path)).rejects.toThrow(ManifestError);
	});

	it("error: CLI hard constraint — concurrency must be 1", async () => {
		const path = await writeManifest(
			"tools.json",
			makeManifest([makeCliTool({ concurrency: 4 })]),
		);
		await expect(loadToolsManifest(path)).rejects.toThrow(/concurrency=1/);
	});

	it("error: CLI hard constraint — retryPolicy must be none", async () => {
		const path = await writeManifest(
			"tools.json",
			makeManifest([makeCliTool({ retryPolicy: "safe-idempotent" })]),
		);
		await expect(loadToolsManifest(path)).rejects.toThrow(/retryPolicy=none/);
	});

	it("error: file does not exist", async () => {
		await expect(loadToolsManifest(join(dir, "missing.json"))).rejects.toThrow(
			/cannot read/,
		);
	});

	it("loads tools.example.json from repo root", async () => {
		const manifest = await loadToolsManifest("tools.example.json");
		expect(manifest.tools).toHaveLength(3);
	});
});

describe("loadToolsManifest — authProfile cross-validation", () => {
	it("accepts a tool with authProfile when knownProfiles includes it", async () => {
		const path = await writeManifest(
			"tools.json",
			makeManifest([makeRestTool({ authProfile: "ichiba-prod" })]),
		);
		const manifest = await loadToolsManifest(path, {
			knownProfiles: new Set(["ichiba-prod"]),
		});
		expect(manifest.tools[0].authProfile).toBe("ichiba-prod");
	});

	it("error when authProfile reference is not in knownProfiles", async () => {
		const path = await writeManifest(
			"tools.json",
			makeManifest([
				makeRestTool({ name: "ichiba__alpha", authProfile: "ichiba-prod" }),
				makeRestTool({ name: "ichiba__beta", authProfile: "ichiba-prod" }),
				makeRestTool({ name: "mantu__gamma", authProfile: "mantu-dev" }),
			]),
		);
		await expect(
			loadToolsManifest(path, { knownProfiles: new Set(["mantu-dev"]) }),
		).rejects.toThrow(/unknown auth profile/);
		await expect(
			loadToolsManifest(path, { knownProfiles: new Set(["mantu-dev"]) }),
		).rejects.toThrow(/ichiba__alpha -> ichiba-prod/);
		await expect(
			loadToolsManifest(path, { knownProfiles: new Set(["mantu-dev"]) }),
		).rejects.toThrow(/ichiba__beta -> ichiba-prod/);
	});

	it("tools without authProfile are unaffected by knownProfiles set", async () => {
		const path = await writeManifest(
			"tools.json",
			makeManifest([makeRestTool()]),
		);
		const manifest = await loadToolsManifest(path, {
			knownProfiles: new Set(),
		});
		expect(manifest.tools).toHaveLength(1);
		expect(manifest.tools[0].authProfile).toBeUndefined();
	});

	it("error when authProfile fails the name regex", async () => {
		const path = await writeManifest(
			"tools.json",
			makeManifest([makeRestTool({ authProfile: "Bad_Name" })]),
		);
		await expect(loadToolsManifest(path)).rejects.toThrow(/authProfile/);
	});
});

describe("loadGatewayConfig — paths + authProfilesPath", () => {
	async function writeYaml(name: string, body: string): Promise<string> {
		const p = join(dir, name);
		await writeFile(p, body, "utf8");
		return p;
	}

	it("parses optional paths + authProfilesPath fields", async () => {
		const path = await writeYaml(
			"gateway.config.yaml",
			[
				"toolsPath: ./tools.json",
				"auditPath: ./audit.jsonl",
				"authProfilesPath: ./auth-profiles.yaml",
				"paths:",
				"  mantu_cookies: C:/Users/me/cookies.txt",
				"profiles:",
				"  coding: [coding]",
			].join("\n"),
		);
		const result = await loadGatewayConfig(path);
		expect(result.config.authProfilesPath).toBe("./auth-profiles.yaml");
		expect(result.config.paths).toEqual({
			mantu_cookies: "C:/Users/me/cookies.txt",
		});
	});

	it("paths + authProfilesPath are optional (back-compat)", async () => {
		const path = await writeYaml(
			"gateway.config.yaml",
			[
				"toolsPath: ./tools.json",
				"auditPath: ./audit.jsonl",
				"profiles:",
				"  coding: [coding]",
			].join("\n"),
		);
		const result = await loadGatewayConfig(path);
		expect(result.config.paths).toBeUndefined();
		expect(result.config.authProfilesPath).toBeUndefined();
	});
});

describe("loadGatewayConfig", () => {
	async function writeYaml(name: string, body: string): Promise<string> {
		const path = join(dir, name);
		await writeFile(path, body, "utf8");
		return path;
	}

	it("loads + validates yaml, resolves relative paths against config dir", async () => {
		const path = await writeYaml(
			"gateway.config.yaml",
			[
				"toolsPath: ./tools.json",
				"auditPath: ./audit.jsonl",
				"profiles:",
				"  coding: [coding, planning]",
				"  ops: [ops]",
			].join("\n"),
		);
		const result = await loadGatewayConfig(path);
		expect(result.config.profiles).toEqual({
			coding: ["coding", "planning"],
			ops: ["ops"],
		});
		expect(result.resolvedToolsPath).toBe(join(dir, "tools.json"));
		expect(result.resolvedAuditPath).toBe(join(dir, "audit.jsonl"));
	});

	it("error: no profiles defined", async () => {
		const path = await writeYaml(
			"gateway.config.yaml",
			"toolsPath: ./tools.json\nauditPath: ./audit.jsonl\nprofiles: {}\n",
		);
		await expect(loadGatewayConfig(path)).rejects.toThrow(
			/at least one profile/,
		);
	});

	it("error: malformed YAML", async () => {
		const path = await writeYaml(
			"gateway.config.yaml",
			"::: not yaml :::\n  - [",
		);
		await expect(loadGatewayConfig(path)).rejects.toThrow(ManifestError);
	});

	it("loads gateway.config.example.yaml from repo root", async () => {
		const result = await loadGatewayConfig("gateway.config.example.yaml");
		expect(Object.keys(result.config.profiles).sort()).toEqual([
			"all",
			"coding",
			"ops",
		]);
	});
});
